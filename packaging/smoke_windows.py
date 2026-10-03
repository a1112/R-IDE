"""Exercise only owned preview processes with isolated data and a Node-free PATH."""
import argparse, ctypes, json, os, shutil, socket, subprocess, tempfile, time
from pathlib import Path
import psutil

ROOT=Path(__file__).resolve().parents[1]
PAYLOAD=ROOT/'artifacts/payload'
USER32=ctypes.windll.user32

def environment(directory):
    result={key:value for key,value in os.environ.items() if not key.upper().startswith(('RIDE_','THEIA_','NODE_','ELECTRON_'))}
    system=Path(os.environ['SystemRoot'])/'System32'
    git=shutil.which('git')
    result['PATH']=os.pathsep.join(map(str,[system,system/'WindowsPowerShell/v1.0',*([Path(git).parent] if git else [])]))
    result.update(RIDE_CONFIG_DIR=str(directory/'config'),WEBVIEW2_USER_DATA_FOLDER=str(directory/'webview'),RUST_LOG='info')
    return result

def windows(pid):
    found=[]
    callback_type=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
    @callback_type
    def collect(handle,_):
        owner=ctypes.c_ulong()
        USER32.GetWindowThreadProcessId(handle,ctypes.byref(owner))
        if owner.value==pid and USER32.IsWindowVisible(handle):
            title=ctypes.create_unicode_buffer(512); USER32.GetWindowTextW(handle,title,512)
            rectangle=(ctypes.c_long*4)(); USER32.GetWindowRect(handle,rectangle)
            found.append({'handle':int(handle),'title':title.value,'rectangle':list(rectangle)})
        return True
    USER32.EnumWindows(collect,0)
    return found

def remember(root,owned):
    try:
        for process in [root,*root.children(recursive=True)]: owned[process.pid]=process.create_time()
    except psutil.NoSuchProcess: pass

def survivors(owned):
    found=[]
    for pid,created in owned.items():
        try:
            process=psutil.Process(pid)
            if process.create_time()==created and process.is_running(): found.append(process)
        except psutil.NoSuchProcess: pass
    return found

def probe(mode,folder):
    with (folder/f'{mode}.log').open('wb') as output:
        child=subprocess.Popen([str(PAYLOAD/'ride-tauri.exe')],cwd=folder,env=environment(folder),stdout=output,stderr=output)
        root=psutil.Process(child.pid); owned={}; evidence={'mode':mode,'pid':child.pid}
        try:
            deadline=time.monotonic()+90
            while time.monotonic()<deadline and child.poll() is None:
                remember(root,owned)
                visible=windows(child.pid)
                listeners=[]
                for process in survivors(owned):
                    try:
                        if process.name().lower()=='node.exe':
                            listeners.extend({'pid':process.pid,'exe':process.exe(),'port':connection.laddr.port}
                                             for connection in process.net_connections('tcp')
                                             if connection.status==psutil.CONN_LISTEN and connection.laddr.port==3000)
                    except (psutil.NoSuchProcess,psutil.AccessDenied): pass
                if visible and listeners:
                    evidence.update(windows=visible,backend=listeners,ownedPids=list(owned)); break
                time.sleep(.2)
            else: raise RuntimeError(f'{mode}: visible window and owned Node listener not ready; see {mode}.log')
            expected=(PAYLOAD/'resources/backend/runtime/node.exe').resolve()
            if any(Path(item['exe']).resolve()!=expected for item in evidence['backend']): raise RuntimeError('Backend used an external Node executable')
            if mode=='normal':
                for window in evidence['windows']: USER32.PostMessageW(ctypes.c_void_p(window['handle']),0x10,0,0)
            else: root.kill()
            child.wait(timeout=25)
            deadline=time.monotonic()+20
            while survivors(owned) and time.monotonic()<deadline: time.sleep(.2)
            if survivors(owned): raise RuntimeError(f'{mode}: owned descendants survived cleanup')
            evidence.update(exitCode=child.returncode,remainingOwnedProcesses=[])
            return evidence
        finally:
            remember(root,owned)
            for process in reversed(survivors(owned)):
                try: process.kill()
                except psutil.NoSuchProcess: pass
            if child.poll() is None: child.wait(timeout=10)

def failure(mode,folder):
    target=PAYLOAD/('resources/backend/runtime/node.exe' if mode=='missing-node' else 'resources/backend/main.js')
    renamed=target.with_name(target.name+'.smoke-disabled')
    blocker=None
    if mode=='busy-port':
        blocker=socket.socket(); blocker.bind(('127.0.0.1',3000)); blocker.listen()
    else: target.rename(renamed)
    child=None; owned={}
    try:
        with (folder/f'{mode}.log').open('wb') as output:
            child=subprocess.Popen([str(PAYLOAD/'ride-tauri.exe')],cwd=folder,env=environment(folder),stdout=output,stderr=output)
            root=psutil.Process(child.pid)
            deadline=time.monotonic()+30
            while time.monotonic()<deadline and child.poll() is None:
                remember(root,owned); time.sleep(.2)
                output.flush()
                text=(folder/f'{mode}.log').read_text(errors='replace')
                if ('already in use' if mode=='busy-port' else 'not found') in text: break
            text=(folder/f'{mode}.log').read_text(errors='replace')
            expected='already in use' if mode=='busy-port' else 'not found'
            if expected not in text: raise RuntimeError(f'{mode}: missing concrete startup diagnostic')
            nodes=[p.pid for p in survivors(owned) if p.name().lower()=='node.exe']
            if nodes: raise RuntimeError(f'{mode}: a backend unexpectedly started')
            for window in windows(child.pid): USER32.PostMessageW(ctypes.c_void_p(window['handle']),0x10,0,0)
            child.wait(timeout=20)
            return {'mode':mode,'diagnostic':expected,'backendPids':nodes,'exitCode':child.returncode}
    finally:
        for process in reversed(survivors(owned)):
            try: process.kill()
            except psutil.NoSuchProcess: pass
        if blocker: blocker.close()
        if renamed.exists(): renamed.rename(target)

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--scenario',choices=('critical-empty','critical-file','backend-retry','lifecycle','failures'),default='critical-empty')
    options=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='rbox-ride-smoke-') as temporary:
        folder=Path(temporary)
        if options.scenario=='lifecycle': result=[probe(mode,folder) for mode in ('normal','forced')]
        elif options.scenario=='failures': result=[failure(mode,folder) for mode in ('missing-node','missing-backend','busy-port')]
        else:
            node=PAYLOAD/'resources/backend/runtime/node.exe'
            command=[str(node),str(ROOT/'app/scripts/run-tauri-packaged-smoke.mjs'),'--executable',str(PAYLOAD/'ride-tauri.exe'),
                     '--scenario',options.scenario,'--output',str(ROOT/f'artifacts/{options.scenario}.json'),'--timeout-ms','120000']
            subprocess.run(command,cwd=folder,env=environment(folder),check=True)
            result={'scenario':options.scenario,'report':f'artifacts/{options.scenario}.json'}
        (ROOT/f'artifacts/{options.scenario}-summary.json').write_text(json.dumps(result,indent=2)+'\n')
        for file in folder.glob('*.log'): shutil.copy2(file,ROOT/'artifacts'/file.name)
        print(json.dumps(result,indent=2))

if __name__=='__main__': main()
