// src/onboarding/code-generator.ts
// 6-character alphanumeric codes for onboarding handshake.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export function isValidCodeFormat(code: string): boolean {
  return /^[a-z0-9]{6}$/.test(code);
}
