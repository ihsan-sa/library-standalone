// Every request lands here (see _routes.json); lib/library.js decides what it answers.
import { handle, configure } from '../lib/library.js';

export const onRequest = (context) => { configure(context.env); return handle(context.request, context.env); };
