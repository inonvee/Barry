// Quick analytic look at a generated mix (no listening required): RMS/peak per second + clipping check.
import fs from 'node:fs';
const f = process.argv[2];
const b = fs.readFileSync(f);
const n = (b.length - 44) / 4, SR = 48000;
let peak = 0, clip = 0;
const rms = [];
for (let s = 0; s < Math.floor(n / SR); s++) {
  let acc = 0, pk = 0;
  for (let i = 0; i < SR; i++) {
    const l = b.readInt16LE(44 + (s * SR + i) * 4) / 32768, r = b.readInt16LE(46 + (s * SR + i) * 4) / 32768;
    acc += (l * l + r * r) / 2; pk = Math.max(pk, Math.abs(l), Math.abs(r));
    if (Math.abs(l) > 0.999 || Math.abs(r) > 0.999) clip++;
  }
  peak = Math.max(peak, pk);
  rms.push([s, 10 * Math.log10(acc / SR + 1e-12), pk]);
}
console.log(`duration ${(n / SR).toFixed(2)}s  peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS  clipped samples ${clip}`);
const bar = (db) => '█'.repeat(Math.max(0, Math.round((db + 60) / 1.6)));
for (const [s, db, pk] of rms) console.log(String(s).padStart(3) + 's ' + db.toFixed(1).padStart(6) + ' dB pk ' + (20 * Math.log10(pk + 1e-9)).toFixed(1).padStart(6) + ' ' + bar(db));
