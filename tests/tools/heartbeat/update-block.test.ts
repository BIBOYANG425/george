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
      reason: 'pulled from conversation',
    });
    expect(result.content[0].text).toMatch(/Updated identity/);
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
