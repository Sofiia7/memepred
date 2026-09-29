import { describe, it, expect } from 'vitest'
import {
  assertEnv,
  validateEnv,
  isHttpUrl,
  resolveFaucetUrl,
  MissingEnvError,
  DEFAULT_FAUCET_URL,
  RPC_VAR_BY_NETWORK,
} from './env'

const ADDR = '0x1111111111111111111111111111111111111111'

/** Everything except the network-specific RPC. */
const BASE_ENV: Record<string, string> = {
  VITE_USDC_ADDRESS: ADDR,
  VITE_MARKET_FACTORY: ADDR,
  VITE_ORACLE_RESOLVER: ADDR,
  VITE_FEE_DISTRIBUTOR: ADDR,
  VITE_REFERRAL_REGISTRY: ADDR,
  VITE_BADGE_NFT: ADDR,
  VITE_LIQUIDITY_POOL: ADDR,
  VITE_GENESIS_NFT: ADDR,
  VITE_API_URL: 'https://api.example.com',
}

const rhcEnv = (over: Record<string, string | undefined> = {}) => ({
  ...BASE_ENV,
  VITE_NETWORK: 'rhc-testnet',
  VITE_RHC_RPC_URL: 'https://rpc.testnet.chain.robinhood.com',
  ...over,
})

const baseEnv = (over: Record<string, string | undefined> = {}) => ({
  ...BASE_ENV,
  VITE_NETWORK: 'sepolia',
  VITE_BASE_RPC_URL: 'https://sepolia.base.org',
  ...over,
})

describe('validateEnv, per-network requirements (audit U11)', () => {
  it('accepts a complete Base env', () => {
    expect(validateEnv(baseEnv())).toEqual([])
    expect(validateEnv(baseEnv({ VITE_NETWORK: 'mainnet' }))).toEqual([])
  })

  it('accepts a complete Robinhood env that has no Base RPC at all', () => {
    const env = rhcEnv()
    expect(env).not.toHaveProperty('VITE_BASE_RPC_URL')
    expect(validateEnv(env)).toEqual([])
    expect(validateEnv(rhcEnv({ VITE_NETWORK: 'rhc' }))).toEqual([])
  })

  it('requires VITE_RHC_RPC_URL on Robinhood builds, and does not ask for the Base one', () => {
    const problems = validateEnv(rhcEnv({ VITE_RHC_RPC_URL: undefined }))
    expect(problems.join('\n')).toContain('VITE_RHC_RPC_URL')
    expect(problems.join('\n')).not.toContain('VITE_BASE_RPC_URL')
  })

  it('does not let a Base RPC stand in for the Robinhood one', () => {
    const problems = validateEnv(
      rhcEnv({ VITE_RHC_RPC_URL: undefined, VITE_BASE_RPC_URL: 'https://sepolia.base.org' }),
    )
    expect(problems.join('\n')).toContain('VITE_RHC_RPC_URL')
  })

  it('requires VITE_BASE_RPC_URL on Base builds, and does not ask for the Robinhood one', () => {
    const problems = validateEnv(baseEnv({ VITE_BASE_RPC_URL: undefined }))
    expect(problems.join('\n')).toContain('VITE_BASE_RPC_URL')
    expect(problems.join('\n')).not.toContain('VITE_RHC_RPC_URL')
  })

  it('maps every network to exactly one RPC variable', () => {
    expect(RPC_VAR_BY_NETWORK).toEqual({
      mainnet: 'VITE_BASE_RPC_URL',
      sepolia: 'VITE_BASE_RPC_URL',
      rhc: 'VITE_RHC_RPC_URL',
      'rhc-testnet': 'VITE_RHC_RPC_URL',
    })
  })

  it('rejects an RPC that is not an absolute http(s) URL', () => {
    for (const bad of ['/rpc', 'not a url', 'wss://rpc.example.com', 'javascript:alert(1)']) {
      const problems = validateEnv(rhcEnv({ VITE_RHC_RPC_URL: bad }))
      expect(problems.join('\n')).toContain('VITE_RHC_RPC_URL')
    }
  })
})

describe('validateEnv, VITE_NETWORK is a strict enum', () => {
  it('flags an unknown value and lists what is accepted, instead of defaulting to a chain', () => {
    for (const bad of ['staging', 'base', 'RHC-MAINNET', 'testnet']) {
      const problems = validateEnv(rhcEnv({ VITE_NETWORK: bad }))
      const text = problems.join('\n')
      expect(text).toContain('VITE_NETWORK')
      expect(text).toContain('mainnet, sepolia, rhc, rhc-testnet')
      expect(text).toContain(JSON.stringify(bad))
    }
  })

  it('does not pile RPC complaints on top of an unknown network', () => {
    const problems = validateEnv({ ...BASE_ENV, VITE_NETWORK: 'staging' })
    expect(problems).toHaveLength(1)
  })

  it('flags an empty or missing value', () => {
    expect(validateEnv(rhcEnv({ VITE_NETWORK: '' })).join('\n')).toContain('VITE_NETWORK (empty)')
    expect(validateEnv(rhcEnv({ VITE_NETWORK: undefined })).join('\n')).toContain('VITE_NETWORK (empty)')
  })

  it('accepts the value with stray whitespace and any casing', () => {
    expect(validateEnv(rhcEnv({ VITE_NETWORK: '  RHC-Testnet\n' }))).toEqual([])
  })
})

describe('validateEnv, the rest', () => {
  it('flags a malformed contract address by name', () => {
    const problems = validateEnv(rhcEnv({ VITE_MARKET_FACTORY: '0x123' }))
    expect(problems).toEqual(['VITE_MARKET_FACTORY (invalid address)'])
  })

  it('flags a missing API URL', () => {
    expect(validateEnv(rhcEnv({ VITE_API_URL: '' }))).toEqual(['VITE_API_URL (empty)'])
  })
})

describe('assertEnv', () => {
  it('throws a MissingEnvError carrying every problem, for main.tsx to show', () => {
    let caught: unknown
    try {
      assertEnv(rhcEnv({ VITE_NETWORK: 'staging', VITE_MARKET_FACTORY: '' }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(MissingEnvError)
    const missing = (caught as MissingEnvError).missing
    expect(missing.some((m) => m.startsWith('VITE_NETWORK'))).toBe(true)
    expect(missing.some((m) => m.startsWith('VITE_MARKET_FACTORY'))).toBe(true)
  })

  it('returns quietly for a complete env', () => {
    expect(() => assertEnv(rhcEnv())).not.toThrow()
  })
})

describe('isHttpUrl and the faucet link', () => {
  it('accepts only absolute http and https URLs', () => {
    expect(isHttpUrl('https://a.example/path?q=1')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:3999')).toBe(true)
    for (const bad of ['', undefined, null, '/rel', 'ftp://x.example', 'javascript:alert(1)', 'data:text/html,hi']) {
      expect(isHttpUrl(bad as string | undefined)).toBe(false)
    }
  })

  it('defaults to the public Robinhood testnet faucet', () => {
    expect(DEFAULT_FAUCET_URL).toBe('https://ethfaucet.com/networks/robinhood/robinhood-testnet')
    expect(resolveFaucetUrl(undefined)).toBe(DEFAULT_FAUCET_URL)
    expect(resolveFaucetUrl('')).toBe(DEFAULT_FAUCET_URL)
  })

  it('takes VITE_FAUCET_URL when it is a real URL, trimmed', () => {
    expect(resolveFaucetUrl('  https://faucet.example.com/rhc \n')).toBe('https://faucet.example.com/rhc')
  })

  it('never turns a bad value into a link a browser would run', () => {
    expect(resolveFaucetUrl('javascript:alert(1)')).toBe(DEFAULT_FAUCET_URL)
    expect(resolveFaucetUrl('ftp://faucet.example.com')).toBe(DEFAULT_FAUCET_URL)
  })
})
