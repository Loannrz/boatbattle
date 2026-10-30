/**
 * Codes de connexion compacts.
 *
 * Une description WebRTC (SDP) complète fait 1 à 3 Ko : trop pour un QR code lisible.
 * Pour une connexion "canal de données uniquement", seules quelques informations
 * comptent : identifiants ICE (ufrag/pwd), empreinte DTLS, rôle DTLS, identifiant
 * de section (mid) et adresses candidates. On les extrait, on les sérialise en
 * binaire puis en base64url : ~150-250 caractères. L'autre côté reconstruit une
 * SDP minimale équivalente.
 *
 * Format texte : "BB1." + base64url(binaire)
 */

export interface Candidate {
  typ: 'host' | 'srflx' | 'prflx' | 'relay';
  ip: string;
  port: number;
}

export interface CompactDesc {
  type: 'offer' | 'answer';
  ufrag: string;
  pwd: string;
  hashAlg: string;
  fingerprint: Uint8Array;
  setup: 'actpass' | 'active' | 'passive';
  mid: string;
  candidates: Candidate[];
}

const PREFIX = 'BB1.';
const CODE_RE = /BB1\.[A-Za-z0-9_-]{20,}/;
const MAX_CANDIDATES = 10;
const TYPS: Candidate['typ'][] = ['host', 'srflx', 'prflx', 'relay'];
const SETUPS: CompactDesc['setup'][] = ['actpass', 'active', 'passive'];

// ---------------- SDP -> compact ----------------

export function parseSdp(sdp: string, type: 'offer' | 'answer'): CompactDesc {
  const lines = sdp.split(/\r?\n/).map((l) => l.trim());
  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();

  const ufrag = get('a=ice-ufrag:');
  const pwd = get('a=ice-pwd:');
  const fp = get('a=fingerprint:');
  const setup = (get('a=setup:') ?? (type === 'offer' ? 'actpass' : 'active')) as CompactDesc['setup'];
  const mid = get('a=mid:') ?? '0';
  if (!ufrag || !pwd || !fp) throw new Error('SDP incomplète');
  const [hashAlg, hex] = fp.split(/\s+/);
  const fingerprint = new Uint8Array(hex.split(':').map((h) => parseInt(h, 16)));

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!l.startsWith('a=candidate:')) continue;
    // candidate:<foundation> <component> <transport> <priority> <ip> <port> typ <type> ...
    const parts = l.slice('a=candidate:'.length).split(/\s+/);
    if (parts.length < 8) continue;
    const [, component, transport, , ip, port, typKw, typ] = parts;
    if (component !== '1' || transport.toLowerCase() !== 'udp' || typKw !== 'typ') continue;
    if (!TYPS.includes(typ as Candidate['typ'])) continue;
    const key = `${ip}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ typ: typ as Candidate['typ'], ip, port: Number(port) });
  }
  // Ordre de préférence : relais/srflx (à distance) et host (même wifi) ; on garde les premiers.
  return {
    type,
    ufrag,
    pwd,
    hashAlg: hashAlg.toLowerCase(),
    fingerprint,
    setup: SETUPS.includes(setup) ? setup : 'actpass',
    mid,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

// ---------------- compact -> SDP ----------------

const BASE_PRIORITY: Record<Candidate['typ'], number> = { host: 126, prflx: 110, srflx: 100, relay: 0 };

export function buildSdp(d: CompactDesc): string {
  const fp = Array.from(d.fingerprint, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const sessionId = Array.from({ length: 18 }, (_, i) => (i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10))).join('');
  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${d.mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ];
  d.candidates.forEach((cand, i) => {
    const priority = (BASE_PRIORITY[cand.typ] << 24) + ((65535 - i) << 8) + 255;
    const rel = cand.typ === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
    lines.push(`a=candidate:${i + 1} 1 udp ${priority} ${cand.ip} ${cand.port} typ ${cand.typ}${rel} generation 0`);
  });
  lines.push(
    `a=ice-ufrag:${d.ufrag}`,
    `a=ice-pwd:${d.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${d.hashAlg} ${fp}`,
    `a=setup:${d.setup}`,
    `a=mid:${d.mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  );
  if (d.candidates.length > 0) lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

// ---------------- binaire ----------------

class Writer {
  bytes: number[] = [];
  u8(n: number) {
    this.bytes.push(n & 255);
  }
  u16(n: number) {
    this.u8(n >> 8);
    this.u8(n);
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new Error('texte trop long');
    this.u8(b.length);
    this.raw(b);
  }
}

class Reader {
  i = 0;
  constructor(private b: Uint8Array) {}
  u8() {
    if (this.i >= this.b.length) throw new Error('code tronqué');
    return this.b[this.i++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  raw(n: number) {
    if (this.i + n > this.b.length) throw new Error('code tronqué');
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  str() {
    return new TextDecoder().decode(this.raw(this.u8()));
  }
}

const UUID_LOCAL = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

function ipv6ToBytes(ip: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v > 0xffff) return null;
    out.push(v >> 8, v & 255);
  }
  return out;
}

function bytesToIpv6(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return groups.join(':');
}

function writeAddress(w: Writer, ip: string): number {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    w.raw(v4.slice(1).map(Number));
    return 0;
  }
  const uuid = ip.match(UUID_LOCAL);
  if (uuid) {
    const hex = uuid.slice(1).join('');
    w.raw(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    return 2;
  }
  const v6 = ipv6ToBytes(ip);
  if (v6) {
    w.raw(v6);
    return 1;
  }
  w.str(ip);
  return 3;
}

function readAddress(r: Reader, kind: number): string {
  if (kind === 0) return Array.from(r.raw(4)).join('.');
  if (kind === 1) return bytesToIpv6(r.raw(16));
  if (kind === 2) {
    const h = Array.from(r.raw(16), (b) => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  }
  return r.str();
}

/** Somme de contrôle sur 8 bits (détecte les codes mal copiés). */
function checksum(bytes: ArrayLike<number>, len: number): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + bytes[i]) % 251;
    b = (b + a) % 251;
  }
  return (a ^ (b << 3)) & 255;
}

function toBase64Url(bytes: number[] | Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) s = s.slice(0, -1); // caractère parasite collé à la fin
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function encodeDesc(d: CompactDesc): string {
  const w = new Writer();
  w.u8(1); // version du format
  w.u8((d.type === 'answer' ? 1 : 0) | (SETUPS.indexOf(d.setup) << 1));
  w.str(d.ufrag);
  w.str(d.pwd);
  w.str(d.hashAlg === 'sha-256' ? '' : d.hashAlg);
  w.u8(d.fingerprint.length);
  w.raw(d.fingerprint);
  w.str(d.mid);
  w.u8(d.candidates.length);
  for (const c of d.candidates) {
    const flagIndex = w.bytes.length;
    w.u8(0);
    const kind = writeAddress(w, c.ip);
    w.u16(c.port);
    w.bytes[flagIndex] = TYPS.indexOf(c.typ) | (kind << 2);
  }
  w.u8(checksum(w.bytes, w.bytes.length));
  return PREFIX + toBase64Url(w.bytes);
}

export function decodeDesc(text: string): CompactDesc {
  const found = codeCandidates(text);
  if (found.length === 0) throw new Error('Code introuvable');
  let lastError: unknown;
  for (const code of found) {
    try {
      return decodeOne(code);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function decodeOne(code: string): CompactDesc {
  const bytes = fromBase64Url(code.slice(PREFIX.length));
  const r = new Reader(bytes);
  if (r.u8() !== 1) throw new Error('Version de code inconnue');
  const flags = r.u8();
  const type = flags & 1 ? 'answer' : 'offer';
  const setup = SETUPS[(flags >> 1) & 3] ?? 'actpass';
  const ufrag = r.str();
  const pwd = r.str();
  const hashAlg = r.str() || 'sha-256';
  const fingerprint = r.raw(r.u8());
  const mid = r.str();
  const count = r.u8();
  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const f = r.u8();
    const ip = readAddress(r, (f >> 2) & 3);
    const port = r.u16();
    candidates.push({ typ: TYPS[f & 3], ip, port });
  }
  const end = r.i;
  if (r.u8() !== checksum(bytes, end)) throw new Error('Code abîmé (vérifiez le copier-coller)');
  return { type, ufrag, pwd, hashAlg, fingerprint, setup, mid, candidates };
}

/**
 * Lectures possibles d'un code dans un texte quelconque (message partagé, lien, QR) :
 * tel quel, puis sans espaces ni retours à la ligne (code coupé par une messagerie).
 * Des caractères collés après le code sont sans effet : le format binaire connaît sa longueur.
 */
function codeCandidates(text: string): string[] {
  const out: string[] = [];
  for (const t of [text, text.replace(/\s+/g, '')]) {
    const m = t.match(CODE_RE);
    if (m && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Retrouve un code valide dans un texte quelconque, ou null. */
export function extractCode(text: string): string | null {
  const found = codeCandidates(text);
  for (const code of found) {
    try {
      decodeOne(code);
      return code;
    } catch {
      /* lecture suivante */
    }
  }
  return null;
}
