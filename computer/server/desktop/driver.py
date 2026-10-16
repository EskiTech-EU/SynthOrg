#!/usr/bin/env python3
"""
The desktop of a computer-use session, inside its container.

One JSON request per line on stdin, one JSON answer per line on stdout, with
the request's id. Nothing else leaves: what the page sees is the text of the
accessibility tree and pictures of the screen.

The model reads the screen through AT-SPI, the accessibility layer screen
readers use: every window, button, field and link comes with its role, its
name and its state, and gets a number in the listing. The model acts on
those numbers. Pressing a control goes through the control's own action;
text is typed on the keyboard (XTest), after the field has the focus, since
some toolkits (Firefox among them) accept text set through AT-SPI without
passing it to the page. Apps that draw everything themselves have no tree:
for them there are screenshots and clicks at a point.
"""
import base64
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import warnings

warnings.filterwarnings('ignore')

DISPLAY = ':1'
APPS_DIRS = ['/usr/share/applications', '/usr/local/share/applications']
TREE_LIMIT = 14000          # characters of listing the model gets at most
NODE_LIMIT = 6000           # nodes visited per application
TEXT_PREVIEW = 160          # characters of a field's or a paragraph's text

# Every toolkit's switch for its accessibility bridge, set for every app:
# GTK and Firefox read the first ones, Qt the QT_ ones, Chromium and Electron
# ACCESSIBILITY_ENABLED. No app is special-cased.
A11Y_ENV = {
    'GTK_A11Y': 'atspi',
    'GNOME_ACCESSIBILITY': '1',
    'MOZ_ENABLE_ACCESSIBILITY': '1',
    'QT_ACCESSIBILITY': '1',
    'QT_LINUX_ACCESSIBILITY_ALWAYS_ON': '1',
    'ACCESSIBILITY_ENABLED': '1',
    'NO_AT_BRIDGE': '0',
}

# Browsers wrap their pages in a sandbox of their own made of user
# namespaces, which this container (no capabilities, no new privileges) does
# not grant: the pages' processes would crash. The boundary here is the
# container itself, so the browsers' inner sandbox is left off.
CONTAINER_ENV = {
    'MOZ_DISABLE_CONTENT_SANDBOX': '1',
    'MOZ_DISABLE_RDD_SANDBOX': '1',
    'MOZ_DISABLE_GMP_SANDBOX': '1',
    'MOZ_DISABLE_SOCKET_PROCESS_SANDBOX': '1',
    'MOZ_DISABLE_UTILITY_SANDBOX': '1',
}

# Action names that mean "use this control", in the order they are preferred.
PRESS_ACTIONS = ['click', 'press', 'activate', 'jump', 'toggle', 'switch', 'open', 'select', 'expand or contract']

# Roles worth listing even without a name: where text goes, or where it is.
TEXT_ROLES = {'text', 'entry', 'password text', 'terminal', 'paragraph', 'static', 'heading', 'document web', 'document text', 'spin button', 'combo box'}
# Roles whose own text the model should read, not just their name.
READ_ROLES = {'paragraph', 'static', 'heading', 'label', 'text', 'entry', 'terminal', 'document text', 'list item', 'table cell', 'link'}
SKIP_ROLES = {'redundant object', 'filler', 'unknown'}

procs = []
# Numbers stay with their element for the whole session: what was [36]
# before a keystroke is still [36] after it, whatever appeared around it.
state = {'nodes': {}, 'ids': {}, 'next': 0, 'size': (1280, 800), 'started': False}
Atspi = None
Gdk = None


def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def spawn(argv, env=None, quiet=True):
    p = subprocess.Popen(argv, env=env or os.environ.copy(), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL if quiet else None,
                         stderr=subprocess.DEVNULL if quiet else None, start_new_session=True)
    procs.append(p)
    return p


def ancestors():
    """This process and the ones that started it (the engine's exec): never stopped by the cleanup."""
    keep, pid = {1}, os.getpid()
    while pid > 1 and pid not in keep:
        keep.add(pid)
        try:
            with open(f'/proc/{pid}/stat') as f:
                pid = int(f.read().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return keep


def parent_and_command(pid):
    try:
        with open(f'/proc/{pid}/stat') as f:
            parent = int(f.read().rsplit(')', 1)[1].split()[1])
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            command = f.read().split(b'\0')
        return parent, command
    except (OSError, ValueError, IndexError):
        return None, []


def stop_the_rest(sig=signal.SIGTERM):
    """
    The container belongs to the desktop alone: everything running in it that
    is not the container's own (its init and its `sleep infinity`), not
    entered from outside (the engine's execs have no parent inside), and not
    this driver or its callers, is the desktop's: X, the buses, the apps and
    what the buses started for them. It goes when the desktop does.
    """
    keep = ancestors()
    for entry in os.listdir('/proc'):
        if not entry.isdigit() or int(entry) in keep:
            continue
        parent, command = parent_and_command(int(entry))
        if parent is None or parent == 0 or (parent == 1 and command[:2] == [b'sleep', b'infinity']):
            continue
        try:
            os.kill(int(entry), sig)
        except OSError:
            pass


def xdo(*args):
    return subprocess.run(['xdotool', *args], capture_output=True, text=True, timeout=30)


# ---------------------------------------------------------------- start

OPENBOX_RC = """<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy></placement>
  <desktops><number>1</number></desktops>
  <applications>
    <application class="*" type="normal"><maximized>yes</maximized><decor>yes</decor></application>
  </applications>
</openbox_config>
"""


def start(width=1280, height=800):
    global Atspi, Gdk
    if state['started']:
        return {'apps': list_apps(), 'size': state['size']}
    width, height = max(640, min(int(width), 2560)), max(480, min(int(height), 1600))
    state['size'] = (width, height)
    os.environ['DISPLAY'] = DISPLAY
    os.environ.update(A11Y_ENV)
    os.environ.update(CONTAINER_ENV)
    # A home made now, owned by whoever runs here: the image's own /root may
    # belong to another user once the container maps ids differently, and
    # browsers refuse to start in a home that is not theirs.
    os.environ['HOME'] = '/tmp/desktop-home'
    # Every desktop starts clean: nothing of an earlier one (apps' sessions,
    # a browser's profile, a bus still up) carries over into this one.
    stop_the_rest(signal.SIGKILL)
    shutil.rmtree(os.environ['HOME'], ignore_errors=True)
    shutil.rmtree('/tmp/.X11-unix', ignore_errors=True)
    for lock in ('/tmp/.X1-lock',):
        try:
            os.remove(lock)
        except OSError:
            pass
    os.makedirs(os.environ['HOME'], mode=0o700, exist_ok=True)
    os.environ.setdefault('XDG_RUNTIME_DIR', '/tmp/xdg')
    os.makedirs(os.environ['XDG_RUNTIME_DIR'], mode=0o700, exist_ok=True)
    spawn(['Xvfb', DISPLAY, '-screen', '0', f'{width}x{height}x24', '-nolisten', 'tcp', '-dpi', '96'])
    for _ in range(50):
        if os.path.exists('/tmp/.X11-unix/X1'):
            break
        time.sleep(0.1)
    bus = subprocess.run(['dbus-daemon', '--session', '--fork', '--print-address', '--nopidfile'],
                         capture_output=True, text=True, timeout=10).stdout.strip()
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = bus
    spawn(['/usr/libexec/at-spi-bus-launcher', '--launch-immediately'])
    rc = os.path.join(os.environ['HOME'], '.config', 'openbox')
    os.makedirs(rc, exist_ok=True)
    with open(os.path.join(rc, 'rc.xml'), 'w') as f:
        f.write(OPENBOX_RC)
    spawn(['openbox', '--config-file', os.path.join(rc, 'rc.xml')])
    time.sleep(0.8)
    import gi
    gi.require_version('Atspi', '2.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Atspi as _Atspi, Gdk as _Gdk
    Atspi, Gdk = _Atspi, _Gdk
    Gdk.init([])
    state['started'] = True
    return {'apps': list_apps(), 'size': state['size']}


# ---------------------------------------------------------------- apps

def list_apps():
    apps = []
    for folder in APPS_DIRS:
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if not name.endswith('.desktop'):
                continue
            entry = read_desktop(os.path.join(folder, name))
            if not entry or entry.get('NoDisplay') == 'true' or entry.get('Type', 'Application') != 'Application' or not entry.get('Exec'):
                continue
            apps.append({'id': name[:-8], 'name': entry.get('Name', name[:-8]), 'what': entry.get('Comment', entry.get('GenericName', ''))})
    return apps


def read_desktop(path):
    out, section = {}, None
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if line.startswith('['):
                    section = line
                    continue
                if section == '[Desktop Entry]' and '=' in line:
                    key, value = line.split('=', 1)
                    if key not in out:
                        out[key] = value
    except OSError:
        return None
    return out


def open_app(app, args=None):
    wanted = str(app or '').strip().lower()
    match = None
    for folder in APPS_DIRS:
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            if not name.endswith('.desktop'):
                continue
            entry = read_desktop(os.path.join(folder, name)) or {}
            if wanted in (name[:-8].lower(), entry.get('Name', '').lower()):
                match = entry
                break
        if match:
            break
    if not match:
        return {'ok': False, 'error': f'app "{app}" non installata', 'apps': list_apps()}
    argv = [part for part in shlex.split(match['Exec']) if not part.startswith('%')]
    # What the caller adds is an address or a file to open, never an option: an
    # argument starting with "-" would be read by the app as a flag (Firefox's
    # -P, -marionette, -private…), not as a place to go. A real URL or path
    # never starts with "-".
    for arg in ([] if not args else [str(a) for a in args][:4]):
        if arg.startswith('-'):
            return {'ok': False, 'error': f'"{arg}" non è un indirizzo o un percorso: gli indirizzi non iniziano con "-".'}
        argv.append(arg)
    before = set(app_names())
    spawn(argv)
    # Up to 25 s for its first window to reach the accessibility tree.
    for _ in range(100):
        time.sleep(0.25)
        if set(app_names()) - before and any_window_for(set(app_names()) - before):
            time.sleep(0.6)
            return {'ok': True}
    return {'ok': True, 'note': "avviata, ma la finestra non è ancora nell'albero: rileggi tra poco"}


def app_names():
    desk = Atspi.get_desktop(0)
    names = []
    for i in range(desk.get_child_count()):
        child = desk.get_child_at_index(i)
        if child:
            names.append(child.get_name() or '')
    return names


def any_window_for(names):
    desk = Atspi.get_desktop(0)
    for i in range(desk.get_child_count()):
        app = desk.get_child_at_index(i)
        if app and (app.get_name() or '') in names and app.get_child_count() > 0:
            return True
    return False


# ---------------------------------------------------------------- tree

def states_of(node):
    st = node.get_state_set()
    S = Atspi.StateType
    return {
        'showing': st.contains(S.SHOWING),
        'focused': st.contains(S.FOCUSED),
        'active': st.contains(S.ACTIVE),
        'checked': st.contains(S.CHECKED) or st.contains(S.PRESSED),
        'selected': st.contains(S.SELECTED),
        'disabled': not st.contains(S.SENSITIVE) and not st.contains(S.ENABLED),
        'editable': st.contains(S.EDITABLE),
        'expanded': st.contains(S.EXPANDED),
        'expandable': st.contains(S.EXPANDABLE),
    }


def actions_of(node):
    try:
        iface = node.get_action_iface()
        if not iface:
            return []
        return [iface.get_action_name(i) for i in range(iface.get_n_actions())]
    except Exception:
        return []


def text_of(node, limit=TEXT_PREVIEW):
    try:
        if node.get_text_iface() is None:
            return ''
        count = Atspi.Text.get_character_count(node)
        text = Atspi.Text.get_text(node, 0, min(count, limit + 1)) or ''
        text = ' '.join(text.replace('￼', ' ').split())
        return text[:limit] + ('…' if count > limit else '')
    except Exception:
        return ''


def box_of(node):
    try:
        e = node.get_extents(Atspi.CoordType.SCREEN)
        return [e.x, e.y, e.width, e.height]
    except Exception:
        return None


def number(obj):
    nid = state['ids'].get(obj)
    if nid is None:
        state['next'] += 1
        nid = state['ids'][obj] = state['next']
        state['nodes'][nid] = obj
    return nid


def tree():
    """The listing the model reads: every window, and in each what can be seen and used."""
    lines = []
    desk = Atspi.get_desktop(0)
    for a in range(desk.get_child_count()):
        app = desk.get_child_at_index(a)
        if not app:
            continue
        for w in range(app.get_child_count()):
            win = app.get_child_at_index(w)
            if not win:
                continue
            try:
                st = states_of(win)
            except Exception:
                continue
            if not st['showing']:
                continue
            wid = number(win)
            lines.append(f"[{wid}] {win.get_role_name()} \"{win.get_name() or ''}\" — app {app.get_name() or '?'}{'  (attiva)' if st['active'] else ''}")
            visited = [0]
            walk(win, 1, lines, visited)
    text = '\n'.join(lines)
    if not lines:
        text = '(nessuna finestra aperta)'
    if len(text) > TREE_LIMIT:
        text = text[:TREE_LIMIT] + f"\n… (elenco tagliato a {TREE_LIMIT} caratteri: scorri o apri la parte che ti serve)"
    return text


def walk(node, depth, lines, visited):
    try:
        count = node.get_child_count()
    except Exception:
        return
    for i in range(min(count, 400)):
        if visited[0] > NODE_LIMIT:
            return
        visited[0] += 1
        try:
            child = node.get_child_at_index(i)
        except Exception:
            continue
        if not child:
            continue
        try:
            role = child.get_role_name()
            st = states_of(child)
        except Exception:
            continue
        if not st['showing']:
            continue
        name = (child.get_name() or '').strip()
        acts = actions_of(child)
        text = text_of(child) if role in READ_ROLES or st['editable'] else ''
        worth = role not in SKIP_ROLES and (name or acts or role in TEXT_ROLES or text)
        if worth and (name or text or acts or st['editable']):
            nid = number(child)
            flags = [k for k in ('focused', 'checked', 'selected', 'disabled', 'expanded') if st[k]]
            if st['editable'] and role not in ('document web',):
                flags.append('scrivibile')
            label = f"\"{name}\"" if name else ''
            shown = text if text and text != name else ''
            line = f"{'  ' * min(depth, 12)}[{nid}] {role} {label}"
            if shown:
                line += f" = \"{shown}\""
            if flags:
                line += f" ({', '.join(flags)})"
            lines.append(line.rstrip())
            walk(child, depth + 1, lines, visited)
        else:
            walk(child, depth, lines, visited)


def node(nid):
    try:
        n = state['nodes'].get(int(nid))
    except (TypeError, ValueError):
        n = None
    if n is None:
        raise ValueError(f'elemento [{nid}] non esiste nell\'ultimo elenco: rileggi lo schermo')
    return n


# ---------------------------------------------------------------- acting

def center(n):
    box = box_of(n)
    if not box or box[2] <= 0 or box[3] <= 0:
        return None
    return box[0] + box[2] // 2, box[1] + box[3] // 2


def pointer_click(x, y, button=1, count=1):
    xdo('mousemove', '--sync', str(int(x)), str(int(y)))
    xdo('click', '--repeat', str(max(1, min(int(count), 3))), str(int(button)))


def click(nid, button='left', count=1):
    n = node(nid)
    if button == 'left' and count == 1:
        acts = actions_of(n)
        for wanted in PRESS_ACTIONS:
            if wanted in acts:
                if n.get_action_iface().do_action(acts.index(wanted)):
                    return {'ok': True, 'how': wanted}
    at = center(n)
    if not at:
        return {'ok': False, 'error': 'elemento senza posizione sullo schermo: non si può cliccare'}
    pointer_click(*at, button={'left': 1, 'middle': 2, 'right': 3}.get(button, 1), count=count)
    return {'ok': True, 'how': 'mouse'}


def focus(n):
    try:
        comp = n.get_component_iface()
        if comp and comp.grab_focus():
            # The state catches up a moment later; the answer is already yes.
            time.sleep(0.15)
            return True
    except Exception:
        pass
    at = center(n)
    if at:
        pointer_click(*at)
        time.sleep(0.15)
        return True
    return False


def type_text(text, nid=None, replace=False, submit=False):
    if nid is not None:
        if not focus(node(nid)):
            return {'ok': False, 'error': 'non riesco a mettere il cursore in quel campo'}
    if replace:
        xdo('key', '--clearmodifiers', 'ctrl+a')
        xdo('key', '--clearmodifiers', 'BackSpace')
    if text:
        xdo('type', '--clearmodifiers', '--delay', '6', '--', str(text))
    if submit:
        xdo('key', '--clearmodifiers', 'Return')
    return {'ok': True}


def keys(combo):
    parts = str(combo or '').split()
    if not parts:
        return {'ok': False, 'error': 'nessun tasto'}
    # Each token is a keysym or a combination of them (Return, ctrl+l, a): the
    # only characters a key name uses. This also keeps a token from being read
    # by xdotool as one of its own options (--window, --delay).
    for token in parts[:12]:
        if not re.fullmatch(r'[A-Za-z0-9_+]+', token):
            return {'ok': False, 'error': f'"{token}" non è un tasto valido.'}
    r = xdo('key', '--clearmodifiers', '--', *parts[:12])
    return {'ok': r.returncode == 0, 'error': r.stderr.strip() or None}


def scroll(direction='down', amount=3, nid=None):
    if nid is not None:
        at = center(node(nid))
    else:
        at = (state['size'][0] // 2, state['size'][1] // 2)
    if at:
        xdo('mousemove', '--sync', str(at[0]), str(at[1]))
    button = {'up': '4', 'down': '5', 'left': '6', 'right': '7'}.get(direction, '5')
    xdo('click', '--repeat', str(max(1, min(int(amount), 20))), button)
    return {'ok': True}


def screenshot(width=None, quality=70):
    root = Gdk.get_default_root_window()
    w, h = state['size']
    pix = Gdk.pixbuf_get_from_window(root, 0, 0, w, h)
    if width and int(width) < w:
        from gi.repository import GdkPixbuf
        nw = int(width)
        pix = pix.scale_simple(nw, int(h * nw / w), GdkPixbuf.InterpType.BILINEAR)
    ok, data = pix.save_to_bufferv('jpeg', ['quality'], [str(max(30, min(int(quality), 95)))])
    return {'ok': bool(ok), 'jpeg': base64.b64encode(data).decode('ascii'), 'size': [w, h]}


def settle(delay=0.5):
    time.sleep(delay)


# ---------------------------------------------------------------- loop

def handle(req):
    cmd = req.get('cmd')
    if cmd == 'start':
        return start(req.get('width', 1280), req.get('height', 800))
    if not state['started']:
        raise ValueError('desktop non avviato')
    if cmd == 'apps':
        return {'apps': list_apps()}
    if cmd == 'tree':
        return {'tree': tree()}
    if cmd == 'inspect':
        n = node(req.get('el'))
        return {'role': n.get_role_name(), 'name': n.get_name(), 'box': box_of(n), 'actions': actions_of(n), 'states': states_of(n), 'text': text_of(n, 2000)}
    if cmd == 'screenshot':
        return screenshot(req.get('width'), req.get('quality', 70))
    if cmd == 'open':
        out = open_app(req.get('app'), req.get('args'))
    elif cmd == 'click':
        out = click(req.get('el'), req.get('button', 'left'), req.get('count', 1))
    elif cmd == 'click_at':
        pointer_click(req.get('x', 0), req.get('y', 0), {'left': 1, 'middle': 2, 'right': 3}.get(req.get('button', 'left'), 1), req.get('count', 1))
        out = {'ok': True}
    elif cmd == 'type':
        out = type_text(req.get('text', ''), req.get('el'), bool(req.get('replace')), bool(req.get('submit')))
    elif cmd == 'key':
        out = keys(req.get('keys'))
    elif cmd == 'scroll':
        out = scroll(req.get('direction', 'down'), req.get('amount', 3), req.get('el'))
    elif cmd == 'wait':
        time.sleep(max(0.2, min(float(req.get('seconds', 1)), 10)))
        out = {'ok': True}
    else:
        raise ValueError(f'comando sconosciuto: {cmd}')
    # Every action answers with the screen as it is afterwards.
    settle(float(req.get('settle', 0.6)))
    out['tree'] = tree()
    return out


def shutdown(*_):
    stop_the_rest(signal.SIGTERM)
    time.sleep(0.5)
    stop_the_rest(signal.SIGKILL)
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, shutdown)
    reply({'id': 0, 'ok': True, 'ready': True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get('id')
        if req.get('cmd') == 'quit':
            reply({'id': rid, 'ok': True})
            break
        try:
            out = handle(req)
            out.setdefault('ok', True)
            out['id'] = rid
            reply(out)
        except Exception as error:
            reply({'id': rid, 'ok': False, 'error': str(error)})
    shutdown()


if __name__ == '__main__':
    main()
