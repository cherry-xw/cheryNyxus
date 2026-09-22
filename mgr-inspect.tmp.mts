import { createManager } from './manager/src/server.js'

;(async () => {
  const lan = createManager({ host: '0.0.0.0', port: 0, controlToken: 'inspect-token' })
  await lan.listen()
  console.log('LAN_URL=http://127.0.0.1:' + lan.address().port + '/')
  const local = createManager({ host: '127.0.0.1', port: 0, controlToken: 'inspect-token' })
  await local.listen()
  console.log('LOCAL_URL=http://127.0.0.1:' + local.address().port + '/')
  setInterval(() => {}, 1000)
})()
