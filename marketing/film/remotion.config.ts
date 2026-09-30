import {Config} from '@remotion/cli/config';
import fs from 'node:fs';

// Remotion's own Chrome download is unavailable in some sandboxes; fall back to a system Chromium.
const candidates = [
  process.env.BROWSER_EXECUTABLE,
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].filter(Boolean) as string[];
const exe = candidates.find((p) => fs.existsSync(p));
if (exe) Config.setBrowserExecutable(exe);

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setCodec('h264');
Config.setCrf(18);
Config.setPixelFormat('yuv420p');
Config.setOverwriteOutput(true);
