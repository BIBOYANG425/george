import { z } from 'zod'
import { getSkillBody } from '../skills/index.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  name: z.string().describe('The skill name from the catalog'),
}

export async function loadSkillHandler(input: { name: string }): Promise<string> {
  const name = input.name
  if (typeof name !== 'string' || name.trim() === '') {
    return "load_skill requires a 'name' argument (string)."
  }
  const body = getSkillBody(name)
  if (body === null) {
    return `Unknown skill: ${name}. Check the catalog for the exact name.`
  }
  return body
}

export const loadSkillTool = wrapTool({
  name: 'load_skill',
  description: 'Load the full playbook for a skill by name. Use when a skill description in the catalog matches the current situation.',
  schema: inputSchema,
  handler: loadSkillHandler,
})
