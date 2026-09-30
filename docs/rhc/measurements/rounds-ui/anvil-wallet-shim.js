// A stand-in wallet for the local browser pass (docs/rhc/ROUNDS-UI.md): run it
// in the page of the LOCAL dev site (dev-rounds.mjs), for example
//   (0, eval)((await import('/@fs/C:/Server/memepred/docs/rhc/measurements/rounds-ui/anvil-wallet-shim.js?raw')).default)
// It announces an EIP-6963 wallet named "Anvil test wallet" and forwards every
// request to the local anvil node, which signs with its own unlocked dev account
// #1. No key is in here or in the page. It talks to 127.0.0.1 only.
;(() => {
  const RPC = 'http://127.0.0.1:8545'
  const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // anvil dev account #1
  const CHAIN_HEX = '0xb626' // 46630, what anvil was started with
  let id = 0
  const listeners = {}
  const rpc = async (method, params) => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
    })
    const json = await res.json()
    if (json.error) {
      const err = new Error(json.error.message)
      err.code = json.error.code
      err.data = json.error.data
      throw err
    }
    return json.result
  }
  const provider = {
    isAnvilShim: true,
    async request({ method, params }) {
      window.__anvilShimLog = window.__anvilShimLog || []
      window.__anvilShimLog.push(method)
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [ACCOUNT]
        case 'eth_chainId':
          return CHAIN_HEX
        case 'wallet_switchEthereumChain':
          if (params?.[0]?.chainId?.toLowerCase() === CHAIN_HEX) return null
          throw Object.assign(new Error('Unrecognized chain'), { code: 4902 })
        case 'wallet_addEthereumChain':
        case 'wallet_requestPermissions':
          return null
        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }]
        default:
          return rpc(method, params)
      }
    },
    on(event, fn) {
      ;(listeners[event] = listeners[event] || []).push(fn)
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn)
    },
  }
  const info = {
    uuid: 'b1d4f0c2-6a1e-4c1b-9d1a-anvil0000001',
    name: 'Anvil test wallet',
    icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Crect width=%2216%22 height=%2216%22 fill=%22%23b48cff%22/%3E%3C/svg%3E',
    rdns: 'local.anvil.shim',
  }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
  return 'anvil shim announced'
})()
