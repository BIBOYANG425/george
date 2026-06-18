// tests/tools/heartbeat/update-block.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createUpdateBlockTool } from '../../../src/tools/heartbeat/update-block.js';

describe('update_block tool', () => {
  it('writes valid block update', async () => {
    const saveBlock = vi.fn().mockResolvedValue(undefined);
    const logAction = vi.fn();
    const tool = createUpdateBlockTool({
      userId: 'u1',
      saveBlock,
      logAction,
    });
    const result = await tool.handler({
      block_name: 'identity',
      new_content: 'name: Alice',
      reason: 'pulled from conversation',
    });
    expect(saveBlock).toHaveBeenCalledWith('u1', 'identity', 'name: Alice');
    expect(logAction).toHaveBeenCalledWith({
      tool: 'update_block',
      block_name: 'identity',
      mode: 'replace',
      reason: 'pulled from conversation',
    });
    expect(result.content[0].text).toMatch(/Updated identity/);
  });

  it('append mode routes to appendToBlock and leaves saveBlock untouched', async () => {
    const saveBlock = vi.fn().mockResolvedValue(undefined);
    const appendToBlock = vi.fn().mockResolvedValue(undefined);
    const logAction = vi.fn();
    const tool = createUpdateBlockTool({ userId: 'u1', saveBlock, appendToBlock, logAction });
    await tool.handler({
      block_name: 'interests',
      new_content: 'into hiking',
      reason: 'said so this turn',
      mode: 'append',
    });
    expect(appendToBlock).toHaveBeenCalledWith('u1', 'interests', 'into hiking');
    expect(saveBlock).not.toHaveBeenCalled();
  });

  it('append mode falls back to saveBlock when no appendToBlock is provided', async () => {
    const saveBlock = vi.fn().mockResolvedValue(undefined);
    const tool = createUpdateBlockTool({ userId: 'u1', saveBlock, logAction: vi.fn() });
    await tool.handler({ block_name: 'state', new_content: 'busy', reason: 'fallback path', mode: 'append' });
    expect(saveBlock).toHaveBeenCalledWith('u1', 'state', 'busy');
  });

  it('rejects unknown block name', async () => {
    const tool = createUpdateBlockTool({
      userId: 'u1',
      saveBlock: vi.fn(),
      logAction: vi.fn(),
    });
    await expect(
      tool.handler({ block_name: 'notreal' as any, new_content: 'x', reason: 'test' })
    ).rejects.toThrow();
  });
});
