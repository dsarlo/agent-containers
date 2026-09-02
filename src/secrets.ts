const credentialOption = String.raw`(?:access[-_]?token|client[-_]?secret|auth[-_]?token|oauth[-_]?token|token|password|secret|api[-_]?key|credentials?|private[-_]?key)`;
const credentialOptionArgument = String.raw`["']?--?${credentialOption}["']?\s*(?:=|\s+)\s*["']?[^\s,'"\]]+`;
const credentialOptionToken = new RegExp(String.raw`^["']?--?${credentialOption}["']?$`, 'i');
const credentialAssignment = new RegExp(String.raw`\b(?:authorization|auth|bearer|${credentialOption})\s*[:=]\s*(?:bearer\s+)?[^\s,'"\]]+`, 'i');

/** Identify a credential-bearing command option without rendering its value. */
export function credentialOptionShaped(value: string): boolean {
  return credentialOptionToken.test(value.includes('=') ? value.slice(0, value.indexOf('=')) : value);
}

/** Classify complete argv/header forms consistently at validation and rendering boundaries. */
export function credentialArgvShaped(argv: readonly string[]): boolean {
  return argv.some((value, index) => credentialOptionShaped(value) ||
    (index > 0 && credentialOptionShaped(argv[index - 1])) ||
    ((value === '-H' || value === '--header') && /^authorization\s*:/i.test(argv[index + 1] ?? '')) ||
    /^authorization\s*:/i.test(value) ||
    (/^bearer$/i.test(value) && /^authorization\s*:/i.test(argv[index - 1] ?? '')));
}

/** Reject credential values, headers, assignments, and PEM material at every durable boundary. */
export function secretShaped(value: string): boolean {
  return new RegExp(String.raw`(?:-----BEGIN [A-Z ]*(?:PRIVATE )?KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b|${credentialAssignment.source}|${credentialOptionArgument})`, 'i').test(value);
}

/** Never render credential-shaped input-derived details in a diagnostic. */
export function redactSecretDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*(?:PRIVATE )?KEY-----[\s\S]*?(?:-----END [A-Z ]*(?:PRIVATE )?KEY-----|$)/gi, '[credential redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url redacted]')
    .replace(new RegExp(credentialAssignment, 'gi'), '[credential redacted]')
    .replace(new RegExp(`(${credentialOptionArgument})`, 'gi'), '[credential redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[credential redacted]')
    .slice(0, 1024);
}
