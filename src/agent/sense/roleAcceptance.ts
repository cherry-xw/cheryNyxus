import { z } from 'zod'
import { sense, type SenseResult } from '@/core/sense/index.js'
import { SupervisionLevel } from '@/core/config.js'
import { runRoleAcceptance } from '@/service/roleAcceptance/index.js'

const RelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value), '必须使用相对路径')
  .refine((value) => !value.split(/[\\/]+/).includes('..'), '路径不能包含 ..')

export const RoleAcceptanceSchema = z.object({
  role: z.string().min(1).max(80).describe('要验收的已激活角色名称'),
  scenarios: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        prompt: z.string().min(1).max(12_000),
        successCriteria: z.string().min(1).max(4_000),
        forbiddenBehavior: z.array(z.string().min(1).max(500)).max(12).optional(),
        fixtures: z
          .array(
            z.object({
              path: RelativePathSchema,
              content: z.string().max(100_000),
            }),
          )
          .max(20)
          .optional(),
        expectedArtifacts: z.array(RelativePathSchema).max(20).optional(),
      }),
    )
    .min(1)
    .max(8),
})

export default sense(
  'role_acceptance',
  '在当前激活配置修订上，对指定角色运行隔离的真实工具端到端场景，并由独立角色依据证据评估。只使用临时工作区；不测试网络、配置修改、外部发送、角色派发、记忆或媒体副作用。',
  RoleAcceptanceSchema,
  async (input): Promise<SenseResult> => {
    try {
      const report = await runRoleAcceptance(input)
      return { content: JSON.stringify(report, null, 2), hash: '' }
    } catch (error) {
      return {
        content: JSON.stringify(
          { passed: false, error: (error as Error).message },
          null,
          2,
        ),
        hash: '',
      }
    }
  },
  SupervisionLevel.auto,
)
