import { EventEmitter } from 'node:events';

export const liveBus = new EventEmitter();
liveBus.setMaxListeners(200);

export function emitLiveUpdate(tenantId, reason = 'update', extra = {}) {
  liveBus.emit('update', { tenantId: tenantId || null, reason, ts: Date.now(), ...extra });
}
