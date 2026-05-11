// Place for API call functions (fetch) to backend routes
// please do not code fetch everywhere else
    
// Generic request wrapper

async function request(method, url, data = null) {

    const options = {
        method,
        headers: {}
    };

    if (data) {

        if (data instanceof FormData) {
            // multer upload
            options.body = data;
        } else {
            // JSON request
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(data);
        }

    }

    const response = await fetch(url, options);

    if (!response.ok) {

        const text = await response.text();

        throw new Error(`[API ERROR] ${method} ${url} -> ${response.status} ${text}`);
    }

    // some endpoints may return empty response
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("application/json")) {
        return response.json();
    }

    return response.text();
}

export async function apiGet(url) {
    return request("GET", url);
}

export async function apiPost(url, data) {
    return request("POST", url, data);
}

export async function apiPut(url, data) {
    return request("PUT", url, data);
}

export async function apiDelete(url) {
    return request("DELETE", url);
}
