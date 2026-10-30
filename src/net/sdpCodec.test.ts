import { describe, expect, it } from 'vitest';
import { buildSdp, decodeDesc, encodeDesc, extractCode, parseSdp } from './sdpCodec';

const FP = Array.from({ length: 32 }, (_, i) => ((i * 37 + 11) & 255).toString(16).padStart(2, '0').toUpperCase()).join(':');

// SDP de type Chrome / Safari (libwebrtc), avec candidat mDNS, srflx, IPv6 et TCP.
const chromeOffer = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:2999745851 1 udp 2122260223 4c0f2d3a-8b3e-4b5a-9f2e-1a2b3c4d5e6f.local 54321 typ host generation 0 network-id 1',
  'a=candidate:842163049 1 udp 1686052607 203.0.113.7 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0',
  'a=candidate:842163050 1 udp 1686052351 2a01:e0a:1f2:3::4 61235 typ srflx raddr :: rport 0 generation 0',
  'a=candidate:1510613869 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=ice-ufrag:Xy7Q',
  'a=ice-pwd:k3J9vQ2mN8pL1sR5tW0yZ4aB',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

// SDP de type Firefox (empreinte au niveau session, UDP en majuscules).
const firefoxAnswer = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 123 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  `a=fingerprint:sha-256 ${FP}`,
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122187007 192.168.1.42 52000 typ host',
  'a=candidate:1 1 UDP 1685987327 198.51.100.9 52000 typ srflx raddr 192.168.1.42 rport 52000',
  'a=candidate:0 2 UDP 2122187006 192.168.1.42 52001 typ host',
  'a=sendrecv',
  'a=ice-pwd:0123456789abcdef0123456789abcdef',
  'a=ice-ufrag:ab12cd34',
  'a=mid:0',
  'a=setup:active',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

describe('codes de connexion compacts', () => {
  it('extrait l\'essentiel d\'une SDP Chrome/Safari', () => {
    const d = parseSdp(chromeOffer, 'offer');
    expect(d.ufrag).toBe('Xy7Q');
    expect(d.pwd).toBe('k3J9vQ2mN8pL1sR5tW0yZ4aB');
    expect(d.setup).toBe('actpass');
    expect(d.mid).toBe('0');
    expect(d.fingerprint).toHaveLength(32);
    expect(d.candidates).toEqual([
      { typ: 'host', ip: '4c0f2d3a-8b3e-4b5a-9f2e-1a2b3c4d5e6f.local', port: 54321 },
      { typ: 'srflx', ip: '203.0.113.7', port: 61234 },
      { typ: 'srflx', ip: '2a01:e0a:1f2:3::4', port: 61235 },
    ]); // le candidat TCP est ignoré
  });

  it('aller-retour encodage / décodage, code court', () => {
    const d = parseSdp(chromeOffer, 'offer');
    const code = encodeDesc(d);
    expect(code.startsWith('BB1.')).toBe(true);
    expect(code.length).toBeLessThan(200);
    const back = decodeDesc(code);
    expect(back.type).toBe('offer');
    expect(back.ufrag).toBe(d.ufrag);
    expect(back.pwd).toBe(d.pwd);
    expect(Array.from(back.fingerprint)).toEqual(Array.from(d.fingerprint));
    expect(back.candidates[0]).toEqual(d.candidates[0]);
    expect(back.candidates[1]).toEqual(d.candidates[1]);
    expect(back.candidates[2].ip).toBe('2a01:e0a:1f2:3:0:0:0:4'); // même adresse, forme développée
  });

  it('SDP Firefox : réponse, rôle actif, composant 2 ignoré', () => {
    const d = parseSdp(firefoxAnswer, 'answer');
    expect(d.setup).toBe('active');
    expect(d.candidates).toHaveLength(2);
    const back = decodeDesc(encodeDesc(d));
    expect(back.type).toBe('answer');
    expect(back.setup).toBe('active');
    expect(back.pwd).toBe('0123456789abcdef0123456789abcdef');
  });

  it('reconstruit une SDP minimale cohérente', () => {
    const sdp = buildSdp(decodeDesc(encodeDesc(parseSdp(chromeOffer, 'offer'))));
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(sdp).toContain('a=ice-ufrag:Xy7Q');
    expect(sdp).toContain(`a=fingerprint:sha-256 ${FP}`);
    expect(sdp).toContain('a=setup:actpass');
    expect(sdp).toMatch(/a=candidate:1 1 udp \d+ 4c0f2d3a-8b3e-4b5a-9f2e-1a2b3c4d5e6f\.local 54321 typ host generation 0/);
    expect(sdp).toMatch(/typ srflx raddr 0\.0\.0\.0 rport 0/);
    // re-parsable
    expect(parseSdp(sdp, 'offer').candidates).toHaveLength(3);
  });

  it('retrouve le code dans un message ou un lien, même coupé', () => {
    const code = encodeDesc(parseSdp(chromeOffer, 'offer'));
    expect(extractCode(`Rejoins ma partie !\nCode : ${code}\nÀ tout de suite`)).toBe(code);
    expect(extractCode(`https://exemple.github.io/boatbattle/#c=${code}`)).toBe(code);
    const wrapped = code.slice(0, 50) + '\n' + code.slice(50);
    expect(extractCode(wrapped)).toBe(code);
    expect(extractCode('rien ici')).toBeNull();
    // caractères parasites collés à la fin : toujours décodable
    expect(decodeDesc(code + 'xyz').ufrag).toBe('Xy7Q');
  });

  it('détecte un code abîmé', () => {
    const code = encodeDesc(parseSdp(chromeOffer, 'offer'));
    const i = 40;
    const broken = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1);
    expect(() => decodeDesc(broken)).toThrow();
    expect(() => decodeDesc(code.slice(0, 30))).toThrow();
  });
});
