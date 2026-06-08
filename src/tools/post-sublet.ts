import { z } from 'zod'
import { supabase } from '../db/client.js'
import { wrapTool } from './_wrap.js'

const inputSchema = {
  student_id: z.string().optional().describe('The student UUID (injected from context)'),
  title: z.string().describe('Listing title'),
  description: z.string().optional().describe('Description'),
  location: z.string().optional().describe('Location'),
  price_monthly: z.number().describe('Monthly rent'),
  available_from: z.string().optional().describe('Available from'),
  available_to: z.string().optional().describe('Available until'),
  contact: z.string().optional().describe('Contact info'),
}

export async function postSubletHandler(input: {
  student_id?: string
  title: string
  description?: string
  location?: string
  price_monthly: number
  available_from?: string
  available_to?: string
  contact?: string
}): Promise<string> {
  if (!input.student_id) return 'No student context available.'
  const { error } = await supabase.from('sublets').insert({
    student_id: input.student_id,
    title: input.title,
    description: input.description || null,
    location: input.location || null,
    price_monthly: input.price_monthly,
    available_from: input.available_from || null,
    available_to: input.available_to || null,
    contact: input.contact || null,
  })
  if (error) return 'Failed to post sublet.'
  return 'Sublet posted! Other students can find it through George. 🏠'
}

export const postSubletTool = wrapTool({
  name: 'post_sublet',
  description: 'Post a sublet listing through George.',
  schema: inputSchema,
  handler: postSubletHandler,
})
