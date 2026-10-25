// Netlify entry: every /api/* request goes to the same handler Vercel uses.
import api from '../../api/index.js';
import { webHandler } from '../../lib/web-adapter.js';

export default webHandler(api);
export const config = { path: '/api/*' };
