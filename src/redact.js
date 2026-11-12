'use strict';

// Secrets never reach a will, and never reach a model. Patterns are deliberately
// greedy: a false positive costs a word, a false negative leaks a key.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b(?:pat|pbt)_[A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bxox[abprse]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bhf_[A-Za-z0-9]{24,}/g, '[redacted]'],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/g, '[redacted]'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}/g, '[redacted]'],
  [/\blin_api_[A-Za-z0-9]{30,}/g, '[redacted]'],
  [/\b(?:dop|dp)_(?:v1_)?[A-Za-z0-9]{40,}/g, '[redacted]'],
  [/(\bBasic\s+)[A-Za-z0-9+/=]{12,}/g, '$1[redacted]'],
  [/(\s(?:-u|--user)\s+["']?[^\s:"']+:)[^\s"']+/g, '$1[redacted]'],
  [/(--(?:token|password|passwd|pass|api-?key|secret|auth-token|access-token|client-secret)[= ]["']?)[^\s"']{4,}/gi, '$1[redacted]'],
  [/((?:AccountKey|SharedAccessKey|SharedAccessSignature|sig)=)[^;&\s"']{8,}/g, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[0-9a-f]{16,}@/gi, '$1[redacted]@'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, '$1[redacted]@'],
  [
    /((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'`,;)}\]]{6,}/gi,
    '$1[redacted]',
  ],
];

function redact(text) {
  if (!text) return '';
  let out = String(text);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

module.exports = { redact };
