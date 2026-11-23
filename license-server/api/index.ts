/**
 * Vercel entry: Node.js runtime, Web-standard handler. vercel.json rewrites every path here.
 * Config errors surface as a thrown ConfigError in the function logs.
 */
import { buildFromEnv } from '../src/bootstrap.js';

export default buildFromEnv().app;
