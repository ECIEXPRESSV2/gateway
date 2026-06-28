import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { EnrichmentService, EnrichedIdentity } from './enrichment.service';
import { RedisService } from '../redis/redis.service';

const IDENTITY: EnrichedIdentity = {
  userId: 'user-uuid-1',
  roles: ['VENDOR'],
  storeId: 'store-uuid-1',
  status: 'ACTIVE',
};

function buildRedisMock(available: boolean, cachedValue: string | null = null) {
  const client = available
    ? { get: jest.fn().mockResolvedValue(cachedValue), setex: jest.fn().mockResolvedValue('OK'), del: jest.fn() }
    : null;
  return {
    getClient: jest.fn().mockReturnValue(client),
    isAvailable: jest.fn().mockReturnValue(available),
    client,
  };
}

describe('EnrichmentService', () => {
  let service: EnrichmentService;
  let redisMock: ReturnType<typeof buildRedisMock>;

  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['IDENTITY_SERVICE_URL'] = 'http://identity:3001';
    process.env['ENRICHMENT_CACHE_TTL_SECONDS'] = '60';
  });

  afterEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  async function buildService(redis: ReturnType<typeof buildRedisMock>) {
    const module = await Test.createTestingModule({
      providers: [
        EnrichmentService,
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    return module.get(EnrichmentService);
  }

  it('cache hit → devuelve sin llamar a Identity', async () => {
    redisMock = buildRedisMock(true, JSON.stringify(IDENTITY));
    service = await buildService(redisMock);

    global.fetch = jest.fn();

    const result = await service.enrich('firebase-uid-1');

    expect(result).toEqual(IDENTITY);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('cache miss → llama Identity, cachea y devuelve', async () => {
    redisMock = buildRedisMock(true, null);
    service = await buildService(redisMock);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(IDENTITY),
    } as any);

    const result = await service.enrich('firebase-uid-2');

    expect(result).toEqual(IDENTITY);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://identity:3001/internal/users/by-firebase/firebase-uid-2',
      expect.any(Object),
    );
    expect(redisMock.client!.setex).toHaveBeenCalledWith(
      'gw:enrich:firebase-uid-2',
      60,
      JSON.stringify(IDENTITY),
    );
  });

  it('Redis no disponible → llama Identity sin cachear', async () => {
    redisMock = buildRedisMock(false);
    service = await buildService(redisMock);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(IDENTITY),
    } as any);

    const result = await service.enrich('firebase-uid-3');

    expect(result).toEqual(IDENTITY);
    expect(global.fetch).toHaveBeenCalled();
    // No client → no setex called
  });

  it('Identity devuelve 404 → propaga HttpException 404', async () => {
    redisMock = buildRedisMock(true, null);
    service = await buildService(redisMock);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: jest.fn(),
    } as any);

    await expect(service.enrich('firebase-uid-no-profile')).rejects.toBeInstanceOf(HttpException);

    try {
      await service.enrich('firebase-uid-no-profile2');
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(404);
      expect(err.getResponse()).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    }
  });

  it('Identity devuelve INACTIVE → pasa a través sin lanzar (el caller verifica status)', async () => {
    const inactiveIdentity: EnrichedIdentity = { ...IDENTITY, status: 'INACTIVE' };
    redisMock = buildRedisMock(true, null);
    service = await buildService(redisMock);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(inactiveIdentity),
    } as any);

    const result = await service.enrich('firebase-uid-inactive');

    expect(result.status).toBe('INACTIVE');
  });
});
