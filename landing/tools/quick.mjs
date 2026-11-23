// Dev helper: node landing/tools/quick.mjs out.png t scale [w h dpr] [--clean]
import { serve, launch, still } from './serve.mjs';
const [out, t = '12', scale = '0.5', w = '1440', h = '900', dpr = '1'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const srv = await serve();
const b = await launch();
const t0 = Date.now();
const errs = await still(b, srv.base, { t: +t, scale: +scale, viewport: { width: +w, height: +h }, dpr: +dpr, path: out, live: process.argv.includes('--live'), jitter: process.argv.some((a) => a.startsWith('--jitter=')) ? +process.argv.find((a) => a.startsWith('--jitter=')).slice(9) : undefined, hideCopy: process.argv.includes('--clean') });
console.log('rendered in', ((Date.now() - t0) / 1000).toFixed(1), 's', errs);
await b.close(); srv.close();
