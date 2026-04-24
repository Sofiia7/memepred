export default {
  async fetch(request: Request): Promise<Response> {
    const country = (request as any).cf?.country as string | undefined

    const BLOCKED = ['US', 'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG']

    if (country && BLOCKED.includes(country)) {
      return new Response(
        JSON.stringify({
          error:   'region_blocked',
          message: 'MemePred is not available in your region.',
          country
        }),
        {
          status:  451,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }

    // Add geo header for backend
    const modReq = new Request(request)
    modReq.headers.set('X-Country', country || 'XX')

    return fetch(modReq)
  }
}
