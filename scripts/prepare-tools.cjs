const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const destination = path.resolve(__dirname, '../src-tauri/tools');
fs.mkdirSync(destination, { recursive: true });
const extension = process.platform === 'win32' ? '.exe' : '';

for (const tool of ['ffmpeg', 'ffprobe']) {
  const filename = `${tool}${extension}`;
  const supplied = process.env.FFMPEG_BIN_DIR && path.join(process.env.FFMPEG_BIN_DIR, filename);
  const lookup = cp.spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [filename], { encoding: 'utf8' });
  const found = supplied && fs.existsSync(supplied) ? supplied : lookup.status === 0 ? lookup.stdout.trim().split(/\r?\n/)[0] : null;
  if (!found || !fs.existsSync(found)) {
    console.error(`Cannot find ${filename}. Install FFmpeg or set FFMPEG_BIN_DIR to its bin directory.`);
    process.exit(1);
  }
  if (process.platform === 'darwin') {
    const linked = cp.spawnSync('otool', ['-L', found], { encoding: 'utf8' });
    if (linked.status !== 0) throw new Error(`Cannot inspect macOS dependencies for ${filename}`);
    const dependencies = linked.stdout.split(/\r?\n/).slice(1).map(line => line.trim().split(' ')[0]).filter(Boolean);
    const external = dependencies.filter(item => !item.startsWith('/usr/lib/') && !item.startsWith('/System/Library/'));
    if (external.length) throw new Error(`${filename} depends on unbundled libraries: ${external.join(', ')}. Supply a self-contained FFmpeg build.`);
  }
  const target = path.join(destination, filename);
  if (path.resolve(found) !== target) fs.copyFileSync(found, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  console.log(`Bundling ${filename} from ${found}`);
  if (tool === 'ffmpeg') {
    const root = path.dirname(path.dirname(found));
    for (const notice of ['LICENSE', 'README.txt']) {
      const source = path.join(root, notice);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, `FFmpeg-${notice}`));
    }
  }
}
