"""Build and stage the isolated R-IDE Windows preview with its runtime/resources."""
import argparse, hashlib, json, os, shutil, subprocess, urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'app'
TAURI=APP/'applications/tauri'
PAYLOAD=ROOT/'artifacts/payload'

def run(arguments,cwd=APP,extra_environment=None):
    env={**os.environ,'RUSTUP_TOOLCHAIN':'1.94.1','CARGO_BUILD_JOBS':'4',
         'ELECTRON_SKIP_BINARY_DOWNLOAD':'1','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD':'1','PUPPETEER_SKIP_DOWNLOAD':'1',
         'PATH':str(NODE.parent)+os.pathsep+os.environ['PATH']}
    env.update(extra_environment or {})
    subprocess.run([str(item) for item in arguments],cwd=cwd,env=env,check=True)

def install_runtime_dependencies(yarn,allow_no_spectre_libraries):
    # Electron's test driver has an unconditional network install script. It is
    # not part of Tauri; execute only the actual browser/runtime install steps.
    run([NODE,yarn,'install','--frozen-lockfile','--ignore-scripts','--network-timeout','100000'])
    patch=APP/'node_modules/patch-package/index.js'
    run([NODE,patch,'--patch-dir','node_modules/@theia/cli/patches'])
    run([NODE,patch,'--patch-dir','patches'])
    for package,script in (('node-pty','scripts/prebuild.js'),('node-pty','scripts/post-install.js'),
                           ('@parcel/watcher','scripts/build-from-source.js'),('esbuild','install.js')):
        run([NODE,APP/'node_modules'/package/script],APP/'node_modules'/package)
    gyp=APP/'node_modules/node-gyp/bin/node-gyp.js'
    python=['--python='+os.environ.get('RIDE_BUILD_PYTHON',os.sys.executable)]
    for name in ('drivelist','native-keymap'):
        run([NODE,gyp,'rebuild','-j','4',*python],APP/'node_modules'/name)
    package=APP/'node_modules/@vscode/windows-ca-certs'
    if allow_no_spectre_libraries:
        run([NODE,gyp,'configure',*python],package)
        configuration=json.loads('\n'.join(line for line in (package/'build/config.gypi').read_text().splitlines() if not line.startswith('#')))
        # Keep /Qspectre on our addon compilation. This explicitly permitted
        # preview fallback links the installed regular MSVC runtime libraries.
        run([configuration['variables']['msbuild_path'],package/'build/binding.sln',
             '/p:Configuration=Release;Platform=x64','/p:SpectreMitigation=false',
             '/nodeReuse:false','/m:4','/nologo'],package,{'CL':'/Qspectre'})
    else:
        run([NODE,gyp,'rebuild','-j','4',*python],package)

def required(path):
    if not path.is_file() or path.stat().st_size==0: raise RuntimeError(f'Missing real build output: {path}')

def copy_tree(source,target):
    if not source.is_dir(): raise RuntimeError(f'Missing resource tree: {source}')
    for item in source.rglob('*'):
        if item.is_symlink(): raise RuntimeError(f'Resource references a source symlink: {item}')
    shutil.copytree(source,target,dirs_exist_ok=True)

def licenses(node_version):
    destination=PAYLOAD/'licenses'; destination.mkdir(parents=True,exist_ok=True)
    for name in ('LICENSE','NOTICE.md'): shutil.copy2(APP/name,destination/name)
    url=f'https://raw.githubusercontent.com/nodejs/node/{node_version}/LICENSE'
    data=urllib.request.urlopen(url,timeout=60).read()
    if len(data)<10000 or b'Copyright Node.js contributors' not in data: raise RuntimeError('Invalid Node license response')
    (destination/'Node-LICENSE.txt').write_bytes(data)
    records=[]
    roots=[APP/'node_modules',APP/'applications/browser/node_modules']
    for modules in roots:
        if not modules.is_dir(): continue
        for directory,folders,files in os.walk(modules,followlinks=False):
            package=Path(directory)/'package.json'
            if not package.is_file(): continue
            try: metadata=json.loads(package.read_text(encoding='utf-8'))
            except (ValueError,UnicodeError): continue
            if not metadata.get('name') or not metadata.get('version'): continue
            texts=[name for name in files if name.upper().startswith(('LICENSE','LICENCE','NOTICE','COPYING'))]
            if not texts: continue
            key=metadata['name'].replace('/','__')+'@'+str(metadata['version'])
            output=destination/'npm'/key; output.mkdir(parents=True,exist_ok=True)
            for name in texts:
                source=Path(directory)/name
                if source.is_file(): shutil.copy2(source,output/name)
            records.append({'name':metadata['name'],'version':metadata['version'],'license':metadata.get('license'),'notices':texts})
    (destination/'npm-attributions.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
    return {'version':node_version,'licenseUrl':url,'licenseSha256':hashlib.sha256(data).hexdigest()}

def main():
    global NODE
    parser=argparse.ArgumentParser()
    parser.add_argument('--skip-install',action='store_true')
    parser.add_argument('--skip-web-build',action='store_true')
    parser.add_argument('--stage-only',action='store_true')
    parser.add_argument('--yarn-cli',type=Path)
    parser.add_argument('--allow-no-spectre-libraries',action='store_true',
                        help='Preview only: retain /Qspectre for CA addon, link regular installed MSVC runtime libraries')
    options=parser.parse_args()
    NODE=Path(shutil.which('node')).resolve()
    npm=NODE.parent/'node_modules/npm/bin/npm-cli.js'
    yarn=options.yarn_cli or Path(shutil.which('yarn.cmd')).parent/'node_modules/yarn/bin/yarn.js'
    required(npm); required(yarn)
    if not options.stage_only:
        if not options.skip_install: install_runtime_dependencies(yarn,options.allow_no_spectre_libraries)
        if not options.skip_web_build:
            run([NODE,yarn,'download:plugins'])
            run([NODE,npm,'run','build:extensions'])
            run([NODE,APP/'scripts/build-tauri-backend.js'])
            # These scripts replace only validated, fixed directories in this checkout.
            for directory in (TAURI/'browser-frontend',TAURI/'tauri-frontend',TAURI/'resources/backend',TAURI/'resources/plugins'):
                if not directory.resolve().is_relative_to(ROOT.resolve()): raise RuntimeError('Resource staging escaped checkout')
            for script in ('copy-frontend.js','copy-backend.js','copy-plugins.js'):
                run([NODE,TAURI/script],TAURI)
        run([NODE,TAURI/'run-tauri-cli.js','build','--no-bundle','--config',ROOT/'packaging/tauri-windows.json'],TAURI)
    required(TAURI/'src-tauri/target/release/ride-tauri.exe')
    required(TAURI/'resources/backend/runtime/node.exe')
    required(TAURI/'resources/backend/main.js')
    required(TAURI/'browser-frontend/index.html')
    pty=list((TAURI/'resources/backend').glob('**/conpty.node'))
    if not pty: raise RuntimeError('Bundled node-pty native addon is missing')
    plugins=list((TAURI/'resources/plugins').glob('*/extension/package.json'))
    if not plugins: raise RuntimeError('Bundled VS Code plugins are missing')
    PAYLOAD.mkdir(parents=True,exist_ok=True)
    shutil.copy2(TAURI/'src-tauri/target/release/ride-tauri.exe',PAYLOAD/'ride-tauri.exe')
    copy_tree(TAURI/'resources/backend',PAYLOAD/'resources/backend')
    copy_tree(TAURI/'resources/plugins',PAYLOAD/'resources/plugins')
    copy_tree(TAURI/'browser-frontend',PAYLOAD/'lib/frontend')
    shutil.copy2(APP/'package.json',PAYLOAD/'package.json')
    shutil.copy2(ROOT/'packaging/README.md',PAYLOAD/'PREVIEW.md')
    version=subprocess.check_output([str(PAYLOAD/'resources/backend/runtime/node.exe'),'--version'],text=True).strip()
    metadata={'productId':'r-ide','sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'platform':'windows-x86_64','entrypoint':'ride-tauri.exe','node':licenses(version),
              'pluginCount':len(plugins),'nodePtyNativeFiles':[str(item.relative_to(TAURI/'resources/backend')).replace('\\','/') for item in pty],
              'requiredFiles':['resources/backend/runtime/node.exe','resources/backend/main.js','resources/plugins','lib/frontend'],
              'userData':'RIDE_CONFIG_DIR or current-user ~/.ride-tauri; downloaded plugins in ~/.ride',
               'caAddonBuild':{'spectreCompiler':True,'spectreRuntimeLibraries':not options.allow_no_spectre_libraries},
              'externalCapabilities':['WebView2','User-configured Git/language runtimes/AI services']}
    (PAYLOAD/'build-info.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')
    print(PAYLOAD)

if __name__=='__main__': main()
