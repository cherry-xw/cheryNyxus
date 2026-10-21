/** A no-work Backend stand-in that speaks the lifecycle messages used by Manager. */
export function withBackendLifecycle(code: string): string {
  return `
    let lifecycleVersion = 0;
    process.on('message', message => {
      if (message.type === 'stop-query') {
        process.send?.({type:'stop-state',state:{backendInstanceId:process.env.CHERY_BACKEND_INSTANCE_ID,
          operationId:null,version:++lifecycleVersion,phase:'running',desiredState:'running',canCancel:false,
          connection:'connected',requestedAt:null,forceDeadlineAt:null,blockers:[],parkedInputCount:0,
          unknownExternalOperations:[],error:null}});
      } else if (message.type === 'stop-drain' || message.type === 'stop-force') {
        process.exit(0);
      }
    });
    ${code}
  `
}
