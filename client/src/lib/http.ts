const CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

export function cors(req: Request): Record<string, string> {
    return {
        'Access-Control-Allow-Origin':  req.headers.get('origin') ?? '*',
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') ?? 'Content-Type, Authorization, x-admin-secret',
    }
}

export function json(req: Request, data: unknown, status = 200): Response {
    return Response.json(data, { status, headers: cors(req) })
}

export function isAuthorized(req: Request): boolean {
    return req.headers.get('x-admin-secret') === process.env.ADMIN_SECRET
}
