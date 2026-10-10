import { createInterface } from 'node:readline/promises'
import { AccountStore } from './accountStore.js'

/** 密码只从交互终端取得；原始模式下不回显输入。 */
export async function hiddenPassword(label: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY || !process.stdout.isTTY) throw new Error('账号设置需要本机交互终端，不接受管道或密码参数')
  process.stdout.write(label)
  const previousRaw = input.isRaw
  input.setRawMode(true)
  input.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      input.off('data', onData)
      input.setRawMode(previousRaw)
      input.pause()
      process.stdout.write('\n')
    }
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new Error('账号设置已取消')); return }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('')
        else if (char >= ' ' && char !== '\u001b') value += char
        if (value.length > 1024) { cleanup(); reject(new Error('密码长度超过限制')); return }
      }
    }
    input.on('data', onData)
  })
}

export async function configureAccount(file: string, reset: boolean): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('账号设置需要本机交互终端，不接受管道或密码参数')
  const account = new AccountStore(file)
  if (!reset && await account.read()) throw new Error('账号已存在，请使用 auth reset')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  let username: string
  try { username = await readline.question('Manager 用户名：') }
  finally { readline.close() }
  const password = await hiddenPassword('Manager 密码（隐藏输入）：')
  const confirmation = await hiddenPassword('再次输入密码：')
  if (password !== confirmation) throw new Error('两次密码不一致，账号未修改')
  await account.save(username, password, reset)
  process.stdout.write('Manager 账号已保存；旧会话失效。该账号与后端账号独立。\n')
}
