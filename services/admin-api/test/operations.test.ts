import { describe, expect, it } from 'vitest';
import { decodeCursor, healthRow, monthsThrough } from '../src/operations.js';
describe('operator read models',()=>{
  it('rejects cursors that escape the intended registry or smuggle arbitrary keys',()=>{
    const encode=(o:unknown)=>Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(()=>decodeCursor(encode({PK:'T#someone',SK:'PROFILE'}),'REGISTRY')).toThrow('Invalid pagination');
    expect(()=>decodeCursor(encode({PK:'REGISTRY',SK:'t/d',extra:'value'}),'REGISTRY')).toThrow('Invalid pagination');
    expect(decodeCursor(encode({PK:'REGISTRY',SK:'t/d'}),'REGISTRY')).toEqual({PK:'REGISTRY',SK:'t/d'});
  });
  it('constructs six chronological months across year boundaries and rejects invalid months',()=>{
    expect(monthsThrough('2026-02')).toEqual(['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02']);
    expect(()=>monthsThrough('2026-13')).toThrow();
  });
  it('re-evaluates stale cached health and returns only the operator projection',()=>{
    const result=healthRow({tenantId:'t',dropId:'d',observedAt:1000,severity:'healthy',email:'buyer@example.com',otpHash:'secret',PK:'REGISTRY'},300000);
    expect(result.severity).toBe('unknown');expect(JSON.stringify(result)).not.toMatch(/buyer@example|secret|REGISTRY/);
  });
});
