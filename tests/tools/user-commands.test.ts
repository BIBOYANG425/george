// tests/tools/user-commands.test.ts
import { describe, it, expect } from 'vitest';
import { parseAndRouteUserCommand } from '../../src/tools/user-commands';

describe('parseAndRouteUserCommand', () => {
  it('recognizes /profile', () => {
    const result = parseAndRouteUserCommand('/profile');
    expect(result).toEqual({ command: 'profile' });
  });

  it('recognizes /correct identity name: Alice', () => {
    const result = parseAndRouteUserCommand('/correct identity name: Alice');
    expect(result).toEqual({
      command: 'correct',
      blockName: 'identity',
      newContent: 'name: Alice',
    });
  });

  it('recognizes /pause (defaults to 7 days)', () => {
    expect(parseAndRouteUserCommand('/pause')).toEqual({ command: 'pause', durationDays: 7 });
  });

  it('recognizes /pause 14 days', () => {
    expect(parseAndRouteUserCommand('/pause 14 days')).toEqual({ command: 'pause', durationDays: 14 });
  });

  it('recognizes /resume', () => {
    expect(parseAndRouteUserCommand('/resume')).toEqual({ command: 'resume' });
  });

  it('recognizes /delete me', () => {
    expect(parseAndRouteUserCommand('/delete me')).toEqual({ command: 'delete_me' });
  });

  it('returns null for non-command text', () => {
    expect(parseAndRouteUserCommand('hey what is iya')).toBeNull();
  });
});
