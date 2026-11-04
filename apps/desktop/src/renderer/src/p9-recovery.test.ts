import { describe, it, expect } from 'vitest';
import { createDesktopStore } from './store.js';
const protocol = { version: 1 as const, hostIncarnation: 'host', connectionId: 'conn', atomicSubmit: true, correlatedToggle: true };
const ready = { type: 'host_ready' as const, workspace: '/ws', mode: 'build' as const, model: 'model', sessionId: 'sess', orchestration: { enabled: true, available: true, posture: 'on' as const }, orchestrationProtocol: protocol };
describe('orchestration delivery recovery', () => {
 it('reconciles a completed report from reconnect snapshot before resuming queue', () => {
  const store = createDesktopStore();
  store.getState().applyHostMessage(ready);
  store.getState().recordSentMessage('report', [], 'r1', undefined, {}, undefined, 'report-id');
  store.getState().applyHostMessage({type:'turn_started', requestId:'r1', turnId:'t1'});
  store.getState().setAwaitingHostReady();
  store.getState().applyHostMessage(ready);
  store.getState().applyHostMessage({type:'presentation_snapshot', items:[], truncated:false, coveredTurnIds:['t1'], historyTracksTurns:false, turns:[{requestId:'r1',turnId:'t1',startedAt:1,text:'report',origin:'system',events:[{event:{type:'loop_end',reason:'completed',turns:1}}]}]});
  store.getState().applyHostMessage({type:'presentation_replay_start'});
  store.getState().applyHostMessage({type:'turn_started',requestId:'r1',turnId:'t1'});
  store.getState().applyHostMessage({type:'agent_event',turnId:'t1',event:{type:'loop_end',reason:'completed',turns:1}});
  store.getState().applyHostMessage({type:'presentation_replay_end'});
  store.getState().enqueuePrompt({text:'next report', images:[], origin:'system',originId:'next'});
  expect(store.getState().takeQueueHead('r2')?.text).toBe('next report');
 });
 it('holds a transition restored by host_ready despite replayed legacy flag', () => {
  const store = createDesktopStore();
  store.getState().applyHostMessage({...ready,orchestration:{enabled:false,available:true,posture:'transitioning'}});
  store.getState().enqueuePrompt({text:'report',images:[],origin:'system',originId:'id'});
  store.getState().applyHostMessage({type:'orchestrate_changed',enabled:false});
  expect(store.getState().takeQueueHead('r')).toBeNull();
 });
 it('settles the current atomic request as uncertain on host unavailable', () => {
  const store = createDesktopStore(); store.getState().applyHostMessage(ready);
  store.getState().beginOrchestrationSubmit('request');
  store.getState().recordSentMessage('task',[],'request','enable');
  store.getState().applyHostMessage({type:'user_message_unavailable',requestId:'request',reason:'orchestrate_unavailable'});
  expect(store.getState().orchestrationDeliveries[0]!.status).toBe('unknown');
 });
 it('accepts only a newer state from the current host connection', () => {
  const store = createDesktopStore();
  store.getState().applyHostMessage({...ready, orchestration:{enabled:false,available:false,posture:'transitioning',revision:5}});
  store.getState().applyHostMessage({type:'orchestration_state',connectionId:'other',revision:6,enabled:true,available:true,posture:'on'});
  store.getState().applyHostMessage({type:'orchestration_state',connectionId:'conn',revision:5,enabled:true,available:true,posture:'on'});
  expect(store.getState().orchestration.posture).toBe('transitioning');
  store.getState().applyHostMessage({type:'orchestration_state',connectionId:'conn',revision:6,enabled:true,available:true,posture:'on'});
  expect(store.getState().orchestration.posture).toBe('on');
 });
 it('ignores unavailable for an already unknown submission', () => {
  const store = createDesktopStore(); store.getState().applyHostMessage(ready);
  store.getState().beginOrchestrationSubmit('request');
  store.getState().recordSentMessage('task',[],'request','enable');
  store.getState().markOrchestrationDeliveryUnknown('request');
  store.getState().applyHostMessage({type:'user_message_unavailable',requestId:'request',reason:'orchestrate_unavailable'});
  expect(store.getState().orchestrationDeliveries[0]!.status).toBe('unknown');
  expect(store.getState().orchestration.pendingSubmit).toBe('request');
 });
});
