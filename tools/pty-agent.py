#!/usr/bin/env python3
"""One agent's pty, held by a process that outlives the PokeClaude server.

Why this is a separate process at all. run-server.sh is a restart loop and
`pkill -f "node src/server/index.js"` is the deploy, so the server dies often and on
purpose. If the server held the pty, every restart would kill every agent. So the pty
lives here, one of these per pen, started detached, and the server attaches and
detaches as it pleases.

Why Python. The standard library has pty and termios, so there is no npm package and
nothing to compile - the zero-dependency rule holds, and a fresh clone runs.

The protocol on the unix socket is length-prefixed frames, never newline-delimited:
terminal output is binary and contains newlines constantly.

    <4-byte big-endian length><1-byte type><payload>

    type 1  output   relay -> client, raw pty bytes
    type 2  input    client -> relay, raw bytes for the pty
    type 3  control  both ways, JSON

The first frame a client sends is control {"since": N}: the byte offset it has already
seen, or 0 for everything the ring buffer still holds. The relay answers with control
{"id","pid","cols","rows","offset"} and then streams. Offsets are monotonic from the
start of the session, so a reconnecting server knows exactly what it missed.

The relay answers the terminal's startup QUERIES itself, with fixed replies. It has to:
an agent whose server is restarting must not stall because nothing told it what kind of
terminal it is. The emulator on the Node side computes replies too and throws them
away - see ptyclient.js, which passes reply: false.
"""
import errno, json, os, pty, select, signal, socket, struct, sys, termios, fcntl, time

HOME = os.path.expanduser('~')
# Overridable so the tests can run relays in a temp directory rather than beside the
# real agents. Nothing else sets it.
ROOT = os.environ.get('POKECLAUDE_PTY_ROOT') or os.path.join(HOME, '.pokeclaude', 'pty')
RING = 512 * 1024          # a full TUI redraw is a few KB, so this is many frames
OUT, IN, CTL = 1, 2, 3

def frame(kind, payload):
    return struct.pack('>IB', len(payload) + 1, kind) + payload

def ctl(obj):
    return frame(CTL, json.dumps(obj).encode())

# The queries both TUIs send at startup and block on. Fixed answers, because this
# process is not an emulator and does not need to be: none of these depend on what is
# on the screen. DA1 says "a VT with colour", XTVERSION names us, and ?u declines the
# kitty keyboard protocol so the TUI falls back to legacy keys.
# A pen is a NEW session, never a child of whoever started the server. These mark the
# starter's own Claude Code session and its IPC, and inheriting them made the agent
# refuse to save a transcript ("inherited CLAUDE_CODE_CHILD_SESSION marker") - which
# PokeClaude then could not read for the model, the context count or the title. The
# CMUX_ pair is cmux's answer to the same question and is ours now.
INHERITED = (
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CMUX_WORKSPACE_ID', 'CMUX_SURFACE_ID',
)

QUERIES = [
    (b'\x1b[c',    b'\x1b[?62;4c'),
    (b'\x1b[>c',   b'\x1b[>0;280;0c'),
    (b'\x1b[>0q',  b'\x1bP>|pokeclaude(1)\x1b\\'),
    (b'\x1b[?u',   b'\x1b[?0u'),
    (b'\x1b[5n',   b'\x1b[0n'),
    (b'\x1b[6n',   b'\x1b[1;1R'),
    (b'\x1b]10;?\x07', b'\x1b]10;rgb:c5c5/c5c5/c5c5\x07'),
    (b'\x1b]11;?\x07', b'\x1b]11;rgb:0000/0000/0000\x07'),
]

def answer(chunk):
    out = b''
    for q, a in QUERIES:
        n = chunk.count(q)
        if n:
            out += a * n
    return out


class Relay:
    def __init__(self, agent_id, cwd, command, cols, rows, scrub=()):
        self.id, self.cwd, self.command = agent_id, cwd, command
        self.cols, self.rows = cols, rows
        # Named by the caller, never kept here: src/server/subscriptions.js is the one
        # list, and a copy in this file would drift from it silently.
        self.scrub = tuple(scrub)
        self.ring, self.offset = bytearray(), 0
        self.tty = None
        self.clients = {}                 # sock -> outgoing bytearray
        self.sock_path = os.path.join(ROOT, f'{agent_id}.sock')
        self.meta_path = os.path.join(ROOT, f'{agent_id}.json')

    def start(self):
        os.makedirs(ROOT, exist_ok=True)
        # Files left by a crashed relay would make bind fail; nothing is listening on
        # them, so they are safe to clear.
        for p in (self.sock_path, self.meta_path):
            try: os.unlink(p)
            except FileNotFoundError: pass

        # openpty and fork by hand rather than pty.fork(), for one reason: we need the
        # SLAVE's name. PokeClaude ties a pen to the Claude session running in it by
        # tty (sessions.js, linkSessions), and a pen with no tty never links - it falls
        # back to guessing the newest transcript in the directory, which is some other
        # agent's conversation. pty.fork() closes the slave without ever naming it.
        master, slave = pty.openpty()
        self.tty = os.ttyname(slave)

        # The order of the next three matters, and both orders I tried first were wrong.
        #
        # The metadata goes first, because everything treats the socket's appearance as
        # "this relay is ready" and so nothing before it may still be missing - a server
        # attaching in that window saw a pen with no directory and no tty. Everything in
        # it but the child's pid is already known here.
        #
        # The socket goes before the fork, because a command that exits immediately
        # would otherwise be gone before the socket existed at all, and the caller would
        # wait out its whole timeout and report a relay that never came up.
        self.write_meta(alive=True)
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.sock_path)
        self.server.listen(16)
        self.server.setblocking(False)

        self.pid = os.fork()
        if self.pid == 0:
            os.close(master)
            try: self.server.close()
            except OSError: pass
            # What pty.fork() does for us, and what a controlling terminal needs: a new
            # session, then claim the slave as its terminal, then be its std streams.
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for target in (0, 1, 2):
                os.dup2(slave, target)
            if slave > 2:
                os.close(slave)
            os.chdir(self.cwd)
            os.environ['TERM'] = 'xterm-256color'
            os.environ['COLORTERM'] = 'truecolor'
            # How the Claude Code hook reports which pen it belongs to. cmux set
            # CMUX_WORKSPACE_ID; this is the same job, ours, and always present.
            os.environ['POKECLAUDE_AGENT_ID'] = self.id
            for k in INHERITED + self.scrub:
                os.environ.pop(k, None)
            os.execvp('/bin/zsh', ['/bin/zsh', '-lc', self.command])
        os.close(slave)
        self.fd = master
        self.resize(self.cols, self.rows)
        os.set_blocking(self.fd, False)
        self.write_meta(alive=True)

    def write_meta(self, alive, exit_code=None):
        tmp = self.meta_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({'id': self.id, 'cwd': self.cwd, 'command': self.command,
                       'pid': getattr(self, 'pid', None), 'relayPid': os.getpid(), 'tty': self.tty,
                       'cols': self.cols, 'rows': self.rows,
                       'startedAt': int(time.time() * 1000),
                       'socket': self.sock_path,
                       'alive': alive, 'exitCode': exit_code}, f)
        os.replace(tmp, self.meta_path)

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def remember(self, chunk):
        self.ring += chunk
        self.offset += len(chunk)
        if len(self.ring) > RING:
            del self.ring[:len(self.ring) - RING]

    def greet(self, sock, since):
        have = self.offset - len(self.ring)
        start = max(since, have)
        # tty travels with the greeting, not only in the metadata file: PokeClaude ties
        # a pen to the Claude session running in it by tty, and a client that attached
        # without reading the file would otherwise have no way to know it.
        head = ctl({'id': self.id, 'pid': self.pid, 'cols': self.cols, 'rows': self.rows,
                    'offset': start, 'command': self.command, 'cwd': self.cwd,
                    'tty': self.tty})
        tail = self.ring[start - have:] if start < self.offset else b''
        self.clients[sock] = bytearray(head + (frame(OUT, bytes(tail)) if tail else b''))

    def broadcast(self, chunk):
        f = frame(OUT, chunk)
        for buf in self.clients.values():
            # A client that cannot keep up is dropped from, never waited on: the pty
            # must not block because a browser tab went to sleep.
            if len(buf) < 4 * 1024 * 1024:
                buf += f

    def run(self):
        pending = {}                       # sock -> incoming bytearray
        exit_code = None
        while True:
            socks = list(self.clients)
            want_write = [s for s in socks if self.clients[s]]
            try:
                r, w, _ = select.select([self.fd, self.server] + socks, want_write, [], 1.0)
            except (OSError, ValueError):
                break

            if self.fd in r:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as e:
                    chunk = b'' if e.errno in (errno.EIO, errno.EBADF) else None
                    if chunk is None: continue
                if not chunk:
                    exit_code = self.reap(); break
                self.remember(chunk)
                self.broadcast(chunk)
                reply = answer(chunk)
                if reply:
                    try: os.write(self.fd, reply)
                    except OSError: pass

            if self.server in r:
                try:
                    c, _ = self.server.accept()
                    c.setblocking(False)
                    pending[c] = bytearray()
                    self.clients[c] = bytearray()
                except OSError:
                    pass

            for s in socks:
                if s not in r: continue
                try: data = s.recv(65536)
                except OSError: data = b''
                if not data: self.drop(s, pending); continue
                pending[s] += data
                self.consume(s, pending)

            for s in w:
                buf = self.clients.get(s)
                if not buf: continue
                try:
                    n = s.send(bytes(buf[:65536]))
                    del buf[:n]
                except OSError:
                    self.drop(s, pending)

            if os.waitpid(self.pid, os.WNOHANG)[0] == self.pid:
                exit_code = 0; break
        self.finish(exit_code)

    def consume(self, sock, pending):
        buf = pending[sock]
        while len(buf) >= 5:
            (n,) = struct.unpack('>I', buf[:4])
            if len(buf) < 4 + n: return
            kind, payload = buf[4], bytes(buf[5:4 + n])
            del buf[:4 + n]
            if kind == IN:
                try: os.write(self.fd, payload)
                except OSError: pass
            elif kind == CTL:
                try: msg = json.loads(payload or b'{}')
                except ValueError: continue
                if 'since' in msg: self.greet(sock, int(msg['since']))
                if 'resize' in msg:
                    self.resize(int(msg['resize']['cols']), int(msg['resize']['rows']))
                    self.write_meta(alive=True)
                if 'signal' in msg:
                    self.kill(getattr(signal, 'SIG' + msg['signal'], signal.SIGTERM))

    def kill(self, sig):
        # The whole process GROUP, not just the shell. forkpty makes the child a session
        # leader, so claude and anything it started share its group; signalling only the
        # shell leaves the real work orphaned and still running.
        try: os.killpg(os.getpgid(self.pid), sig)
        except OSError:
            try: os.kill(self.pid, sig)
            except OSError: pass

    def drop(self, sock, pending):
        self.clients.pop(sock, None); pending.pop(sock, None)
        try: sock.close()
        except OSError: pass

    def reap(self):
        try: return os.waitpid(self.pid, 0)[1] >> 8
        except OSError: return None

    def finish(self, exit_code):
        bye = ctl({'exit': exit_code})
        for s in list(self.clients):
            try: s.sendall(bye)
            except OSError: pass
            try: s.close()
            except OSError: pass
        self.write_meta(alive=False, exit_code=exit_code)
        try: self.server.close()
        except OSError: pass
        try: os.unlink(self.sock_path)
        except OSError: pass


def daemonize(log):
    # Two forks and a setsid, so the relay is not in the server's process group and a
    # pkill of the server cannot take the agents with it.
    if os.fork() > 0: os._exit(0)
    os.setsid()
    if os.fork() > 0: os._exit(0)
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    os.dup2(fd, 1); os.dup2(fd, 2)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', required=True)
    ap.add_argument('--cwd', required=True)
    ap.add_argument('--command', required=True)
    ap.add_argument('--cols', type=int, default=200)
    ap.add_argument('--rows', type=int, default=50)
    ap.add_argument('--foreground', action='store_true')
    # Everything that would send a CLI somewhere other than its subscription login.
    ap.add_argument('--scrub', default='')
    a = ap.parse_args()
    os.makedirs(ROOT, exist_ok=True)
    if not a.foreground:
        daemonize(os.path.join(ROOT, f'{a.id}.log'))
    r = Relay(a.id, a.cwd, a.command, a.cols, a.rows,
              tuple(x for x in a.scrub.split(',') if x))
    r.start()
    try:
        r.run()
    except KeyboardInterrupt:
        r.finish(None)

if __name__ == '__main__':
    main()
