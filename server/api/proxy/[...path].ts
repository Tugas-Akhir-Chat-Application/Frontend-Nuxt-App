import {
  defineEventHandler,
  getRouterParams,
  readBody,
  sendProxy,
  setHeader,
  createError,
} from "h3";
import { getMethod, getQuery, getRequestHeaders, getHeader } from "h3";
import { createServer } from "node:http";
import { proxyRequest } from "h3";

// Define a more complete RequestInit type to include duplex
interface EnhancedRequestInit extends RequestInit {
  duplex?: "half";
}

// Base URLs for different services from environment variables
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8081/api";
const GROUP_API_BASE_URL =
  process.env.GROUP_API_BASE_URL || "http://localhost:8082/api";
const NOTIFICATION_API_BASE_URL =
  process.env.NOTIFICATION_API_BASE_URL || "http://localhost:8083/api";
const FILE_SERVICE_BASE_URL =
  process.env.FILE_SERVICE_BASE_URL || "http://localhost:8084"; // File service base URL
const PRESENCE_SERVICE_BASE_URL =
  process.env.PRESENCE_SERVICE_BASE_URL || "http://localhost:8085/api"; // Presence service base URL

// Helper function to ensure URLs are properly formatted
const ensureValidUrl = (url: string): string => {
  // Add http:// protocol if missing
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }
  // Make sure we don't have double slashes in the path portion
  return url.replace(/([^:]\/)\/+/g, "$1");
};

// Helper function to set CORS headers
const setCorsHeaders = (event: any) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(
    event,
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS, PATCH"
  );
  setHeader(
    event,
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept"
  );
  setHeader(event, "Access-Control-Allow-Credentials", "true");
};

// Before making the API request, validate token
const validateToken = (token: string | undefined): boolean => {
  if (!token) {
    console.error("[Server Proxy] No token provided");
    return false;
  }

  try {
    // Basic token structure validation for JWT
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) {
      console.warn("[Server Proxy] Token does not have standard JWT structure");
      // Even if it's not a standard JWT, we'll allow it through and let the backend decide
      return true;
    }

    try {
      // Try to decode the payload - might fail if the token is not properly padded
      const decoded = Buffer.from(payload, "base64").toString();
      const decodedPayload = JSON.parse(decoded);

      // Check token expiration if present
      if (decodedPayload.exp && Date.now() >= decodedPayload.exp * 1000) {
        console.warn(
          "[Server Proxy] Token may be expired, but proceeding anyway"
        );
        // We still return true to allow the backend to make the final decision
        return true;
      }
    } catch (decodeError) {
      // If we can't decode the payload, it might be encoded differently
      console.warn(
        "[Server Proxy] Could not decode token payload, but proceeding with request"
      );
      return true;
    }

    return true;
  } catch (error) {
    console.error("[Server Proxy] Token validation error:", error);
    // Even with validation error, we'll still forward the token and let the backend decide
    return true;
  }
};

export default defineEventHandler(async (event) => {
  try {
    // Set CORS headers for all responses
    setCorsHeaders(event);

    // Get HTTP method
    const method = getMethod(event);

    // Handle CORS preflight requests (OPTIONS method)
    if (method === "OPTIONS") {
      console.log("[Server Proxy] Handling CORS preflight request");

      // Set additional CORS headers for preflight response
      setHeader(event, "Access-Control-Max-Age", 86400); // 24 hours

      // Return empty response with 200 status for preflight
      return new Response(null, { status: 200 });
    }

    // Force specific methods for certain endpoints
    let forcedMethod = method;
    const params = getRouterParams(event);
    const pathArray = Array.isArray(params.path) ? params.path : [params.path];
    let pathString = pathArray.join("/");

    console.log(`[Server Proxy] Raw params:`, params);
    console.log(`[Server Proxy] Path array:`, pathArray);
    console.log(`[Server Proxy] Path string:`, pathString);

    // Clean up path string - remove any 'api/proxy' prefix if it somehow gets included
    if (pathString.startsWith("api/proxy/")) {
      pathString = pathString.substring(10); // Remove 'api/proxy/' prefix
      console.log(`[Server Proxy] Cleaned path string:`, pathString);
    } else if (pathString.startsWith("proxy/")) {
      pathString = pathString.substring(6); // Remove 'proxy/' prefix
      console.log(`[Server Proxy] Cleaned path string:`, pathString);
    }

    if (pathArray.join("/").includes("friends/add")) {
      console.log(
        "[Server Proxy] Forcing POST method for /friends/add endpoint"
      );
      forcedMethod = "POST";
    }

    // Get request headers to forward auth headers
    const requestHeaders = getRequestHeaders(event);

    if (pathString === "users/profile/avatar") {
      console.log(
        "[Server Proxy] Profile avatar endpoint detected, using PUT method"
      );
      console.log(
        `[Server Proxy] Original method: ${method}, Content-Type: ${
          requestHeaders["content-type"] || "none"
        }`
      );
    }

    console.log(
      `[Server Proxy] Received ${method} request for path:`,
      pathString
    );

    // Get query parameters
    const query = getQuery(event);

    // Check if this is a login or register request - these shouldn't use existing tokens
    const isAuthEndpoint =
      pathString === "auth/login" ||
      pathString === "login" ||
      pathString === "auth/register" ||
      pathString === "register";

    if (isAuthEndpoint) {
      console.log(
        `[Server Proxy] Auth endpoint detected: ${pathString} - will skip token validation`
      );
    }

    // Determine which API to route to
    let baseUrl = API_BASE_URL;
    let isFileRequest = false;
    let isWebSocketRequest = false;

    // Route ALL message-related endpoints to GROUP_API_BASE_URL (port 8082)
    // This includes: message/history, messages/history, message/*, messages/*
    if (
      pathString.startsWith("message") || // Covers both "message" and "messages"
      pathString.includes("/message") || // Covers paths like "group/123/messages"
      pathString.startsWith("groups/messages") ||
      (pathString.startsWith("group/") && pathString.includes("/messages"))
    ) {
      baseUrl = GROUP_API_BASE_URL; // Messages service is on port 8082
      console.log(
        `[Server Proxy] MESSAGE ENDPOINT DETECTED: Routing ${pathString} to ${baseUrl}`
      );
    }

    // Route to notifications service
    if (pathString.startsWith("notifications")) {
      baseUrl = NOTIFICATION_API_BASE_URL;
      console.log(
        `[Server Proxy] Routing to NOTIFICATION_API_BASE_URL: ${baseUrl}`
      );
    }
    // Route to presence service
    else if (pathString.startsWith("presence")) {
      baseUrl = PRESENCE_SERVICE_BASE_URL;
      console.log(
        `[Server Proxy] Routing to PRESENCE_SERVICE_BASE_URL: ${baseUrl}`
      );

      // Special handling for presence/users endpoint with query parameters
      if (
        pathString.startsWith("presence/users") &&
        Object.keys(query).length > 0
      ) {
        console.log(
          `[Server Proxy] Special handling for presence/users endpoint with query params`
        );
        console.log(`[Server Proxy] Query parameters:`, query);

        // Log the user_ids to help debug URL construction issues
        if (query.user_ids) {
          console.log(`[Server Proxy] User IDs parameter: ${query.user_ids}`);

          // Ensure the user_ids parameter is properly handled
          try {
            // Add detailed logging
            console.log(`[Server Proxy] Presence user_ids detailed info:`, {
              rawValue: query.user_ids,
              type: typeof query.user_ids,
              containsComma: String(query.user_ids).includes(","),
              length: String(query.user_ids).length,
            });

            // Ensure base URL has protocol
            if (
              !baseUrl.startsWith("http://") &&
              !baseUrl.startsWith("https://")
            ) {
              baseUrl = `http://${baseUrl}`;
              console.log(
                `[Server Proxy] Added protocol to presence service URL: ${baseUrl}`
              );
            }
          } catch (error) {
            console.error(
              `[Server Proxy] Error processing presence user_ids:`,
              error
            );
          }
        }
      }
    }
    // Route other group-specific requests (both "groups" and "group" paths) - only non-message group operations
    else if (
      (pathString.startsWith("groups") || pathString.startsWith("group")) &&
      !pathString.includes("message") // Exclude message-related paths as they're handled above
    ) {
      baseUrl = ensureValidUrl(GROUP_API_BASE_URL);
      console.log(`[Server Proxy] Routing to GROUP_API_BASE_URL: ${baseUrl}`);
      // Log group request details for debugging
      console.log(`[Server Proxy] GROUP REQUEST DETAILS:`);
      console.log(`[Server Proxy] - Original path: ${pathString}`);
      console.log(`[Server Proxy] - Base URL: ${baseUrl}`);
      console.log(`[Server Proxy] - Query params:`, query);
    }
    // Route to file service (handle both files and media)
    else if (pathString.startsWith("files") || pathString.startsWith("media")) {
      baseUrl = FILE_SERVICE_BASE_URL;
      isFileRequest = true;
      console.log(
        `[Server Proxy] Routing to FILE_SERVICE_BASE_URL: ${baseUrl} for path: ${pathString}`
      );
    }

    // Check if this is a WebSocket upgrade request
    isWebSocketRequest = !!(
      requestHeaders.connection?.toLowerCase().includes("upgrade") &&
      requestHeaders.upgrade?.toLowerCase() === "websocket"
    );

    if (isWebSocketRequest) {
      console.log("[Server Proxy] WebSocket connection request detected");

      // Determine the WebSocket service to connect to based on path
      let wsTarget = "";
      if (pathString.startsWith("messages/ws")) {
        // Convert HTTP URL to WebSocket URL for GROUP API (messages service)
        const wsBaseUrl = GROUP_API_BASE_URL.replace(/^http/, "ws");
        wsTarget = `${wsBaseUrl}/messages/ws`;
        console.log("[Server Proxy] Routing WebSocket to MESSAGES service");
      } else if (pathString.startsWith("presence/ws")) {
        // Convert HTTP URL to WebSocket URL for PRESENCE API
        const wsBaseUrl = PRESENCE_SERVICE_BASE_URL.replace(/^http/, "ws");
        wsTarget = `${wsBaseUrl}/presence/ws`;
        console.log("[Server Proxy] Routing WebSocket to PRESENCE service");
      }

      if (wsTarget) {
        // For WebSocket connections, use h3's built-in proxy functionality to handle the upgrade
        const targetUrl = new URL(wsTarget);

        // Add query parameters if present
        if (Object.keys(query).length > 0) {
          for (const [key, value] of Object.entries(query)) {
            targetUrl.searchParams.append(key, value as string);
          }
        }

        console.log(
          `[Server Proxy] Proxying WebSocket to: ${targetUrl.toString()}`
        );

        // Extract token from query or cookies for Authorization
        let token = query.token as string;
        if (!token && requestHeaders.cookie) {
          const cookieStr = requestHeaders.cookie;
          const cookies = cookieStr.split(";").reduce((acc, cookie) => {
            const [key, value] = cookie.trim().split("=");
            acc[key] = value;
            return acc;
          }, {} as Record<string, string>);
          token = cookies.auth_token;
        }

        try {
          // Use proxyRequest from h3 which handles WebSocket upgrades properly
          return proxyRequest(event, targetUrl.toString(), {
            // Forward essential headers for WebSocket
            headers: {
              // Include upgrade and connection headers explicitly
              Upgrade: "websocket",
              Connection: "Upgrade",
              // Forward Authorization header if we have a token
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              // Include other headers that might be needed
              ...(requestHeaders.origin
                ? { Origin: requestHeaders.origin }
                : {}),
              ...(requestHeaders["sec-websocket-key"]
                ? { "Sec-WebSocket-Key": requestHeaders["sec-websocket-key"] }
                : {}),
              ...(requestHeaders["sec-websocket-version"]
                ? {
                    "Sec-WebSocket-Version":
                      requestHeaders["sec-websocket-version"],
                  }
                : {}),
              ...(requestHeaders["sec-websocket-extensions"]
                ? {
                    "Sec-WebSocket-Extensions":
                      requestHeaders["sec-websocket-extensions"],
                  }
                : {}),
            },
            // Additional proxy options for better error handling
            // Remove the fetch with timeout property since it's not supported
          });
        } catch (error) {
          console.error(
            `[Server Proxy] WebSocket proxy error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
          return {
            error: true,
            message: "Failed to establish WebSocket connection",
          };
        }
      }
    }

    // Handle WebSocket upgrade for presence service
    if (pathString.includes("presence/ws")) {
      console.log(
        "[Server Proxy] Handling WebSocket upgrade request for presence service"
      );

      // Extract token from query params
      const token = query.token as string;
      if (!token) {
        throw new Error("No token provided for WebSocket connection");
      }

      // Build WebSocket URL using environment variable
      const wsBaseUrl = PRESENCE_SERVICE_BASE_URL.replace(
        /^http/,
        "ws"
      ).replace("/api", "");
      const wsUrl = `${wsBaseUrl}/presence/ws?token=${token}`;
      console.log("[Server Proxy] WebSocket target URL:", wsUrl);

      // Return WebSocket URL for client to connect directly
      // This bypasses the proxy for WebSocket connections
      return { wsUrl };
    }

    // Build target URL - special handling for different services
    let url;

    // Handle messages/history and message/history endpoints specially
    if (pathString === "messages/history" || pathString === "message/history") {
      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Always use the plural form for the actual API endpoint
      url = `${baseWithProtocol}/messages/history`;
      console.log(
        `[Server Proxy] Special URL construction for message/history: ${url}`
      );
    }
    // Handle presence/users endpoint specially
    else if (pathString.startsWith("presence/users")) {
      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Construct URL with explicit formatting for presence/users
      url = `${baseWithProtocol}/presence/users`;
      console.log(
        `[Server Proxy] Special URL construction for presence/users: ${url}`
      );

      // If we have user_ids in query parameters, handle them specially
      if (query.user_ids) {
        console.log(
          `[Server Proxy] Processing presence user_ids: ${query.user_ids}`
        );

        // Special handling for comma-separated IDs
        const userIdsValue = query.user_ids as string;
        if (userIdsValue.includes(",")) {
          console.log(`[Server Proxy] Detected comma-separated user IDs`);

          try {
            // Split, trim, and re-encode each ID separately
            const idParts = userIdsValue.split(",");
            const encodedIds = idParts
              .map((id) => encodeURIComponent(id.trim()))
              .join(",");

            // Construct URL with properly encoded user_ids
            url = `${url}?user_ids=${encodedIds}`;
            console.log(
              `[Server Proxy] Constructed presence URL with encoded IDs: ${url}`
            );
          } catch (encodeError) {
            console.error(
              `[Server Proxy] Error encoding user_ids:`,
              encodeError
            );

            // Fallback to standard encoding
            const presenceParams = new URLSearchParams();
            presenceParams.append("user_ids", userIdsValue);
            url = `${url}?${presenceParams.toString()}`;
            console.log(`[Server Proxy] Fallback presence URL: ${url}`);
          }
        } else {
          // For single IDs, standard encoding is fine
          const presenceParams = new URLSearchParams();
          presenceParams.append("user_ids", userIdsValue);
          url = `${url}?${presenceParams.toString()}`;
          console.log(`[Server Proxy] Added user_ids to presence URL: ${url}`);
        }
      }
    }
    // Handle message/{id} endpoint specially (for getting individual messages)
    else if (
      pathString.startsWith("message/") &&
      pathString.split("/").length === 2 &&
      method === "GET"
    ) {
      // Extract the message ID
      const parts = pathString.split("/");
      const messageId = parts[1];

      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Use the plural form for the actual API endpoint
      url = `${baseWithProtocol}/messages/${messageId}`;

      console.log(
        `[Server Proxy] Special URL construction for message/{id}: ${url}`
      );
    }
    // Handle message deletion endpoint specially
    else if (
      (pathString.startsWith("messages/") ||
        pathString.startsWith("message/")) &&
      pathString.split("/").length >= 2 &&
      method === "DELETE"
    ) {
      // Extract the message ID
      const parts = pathString.split("/");
      const messageId = parts[1];

      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Use the plural form for the actual API endpoint
      url = `${baseWithProtocol}/messages/${messageId}`;

      console.log(
        `[Server Proxy] Special URL construction for message deletion: ${url}`
      );
    }
    // Handle message update/edit endpoint specially
    else if (
      (pathString.startsWith("messages/") ||
        pathString.startsWith("message/")) &&
      pathString.split("/").length >= 2 &&
      (method === "PUT" || method === "PATCH")
    ) {
      // Extract the message ID
      const parts = pathString.split("/");
      const messageId = parts[1];

      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Use the plural form for the actual API endpoint
      url = `${baseWithProtocol}/messages/${messageId}`;

      console.log(
        `[Server Proxy] Special URL construction for message update: ${url}`
      );
    }
    // Handle message creation endpoint specially
    else if (
      (pathString === "messages" || pathString === "message") &&
      method === "POST"
    ) {
      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Use the plural form for the actual API endpoint
      url = `${baseWithProtocol}/messages`;

      console.log(
        `[Server Proxy] Special URL construction for message creation: ${url}`
      );
    }
    // Handle other message endpoints (read, search, unread-count, etc.)
    else if (
      (pathString.startsWith("messages/") ||
        pathString.startsWith("message/")) &&
      (pathString.includes("/read") ||
        pathString.includes("/search") ||
        pathString.includes("/unread-count"))
    ) {
      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Convert message/ to messages/ for consistency
      const normalizedPath = pathString.startsWith("message/")
        ? pathString.replace("message/", "messages/")
        : pathString;

      url = `${baseWithProtocol}/${normalizedPath}`;

      console.log(
        `[Server Proxy] Special URL construction for message endpoint: ${url}`
      );
    }
    // Handle presence endpoints specially
    else if (pathString.startsWith("presence/")) {
      // Ensure base URL has protocol
      const baseWithProtocol = baseUrl.startsWith("http")
        ? baseUrl
        : `http://${baseUrl}`;

      // Get the path after "presence/"
      const presencePath = pathString.substring("presence/".length);

      // Construct URL for presence endpoints
      url = `${baseWithProtocol}/${pathString}`;

      console.log(
        `[Server Proxy] Special URL construction for presence endpoint: ${url}`
      );

      // Special handling for users endpoint with query parameters
      if (presencePath.startsWith("users") && Object.keys(query).length > 0) {
        console.log(
          `[Server Proxy] Handling presence/users with query parameters`
        );
      }
    } else if (isFileRequest) {
      // For file service, ensure proper API path structure
      // Convert 'files/...' to '/api/files/...' and 'media/...' to '/api/media/...'
      if (pathString.startsWith("files/")) {
        const filePath = pathString.substring(6); // Remove 'files/' prefix
        url = `${baseUrl}/api/files/${filePath}`;
      } else if (pathString.startsWith("media/")) {
        const mediaPath = pathString.substring(6); // Remove 'media/' prefix
        url = `${baseUrl}/api/media/${mediaPath}`;
      } else if (pathString === "files") {
        url = `${baseUrl}/api/files`;
      } else if (pathString === "media") {
        url = `${baseUrl}/api/media`;
      } else {
        // Fallback for other file service paths
        url = `${baseUrl}/api/${pathString}`;
      }
      console.log(`[Server Proxy] File service URL constructed: ${url}`);
    } else if (pathString.startsWith("presence")) {
      // Use the already set baseUrl which should be PRESENCE_SERVICE_BASE_URL
      url = `${baseUrl}/${pathString}`;
      console.log(`[Server Proxy] Routing presence request to: ${url}`);
    } else if (pathString.startsWith("notifications")) {
      // For notification service
      url = `${baseUrl}/${pathString}`;
      console.log(`[Server Proxy] Routing notification request to: ${url}`);
    } else if (
      pathString.startsWith("groups") ||
      pathString.startsWith("group")
    ) {
      // Special handling for group requests with explicit URL construction
      // First, ensure the base URL has a protocol
      const baseWithProtocol =
        baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
          ? baseUrl
          : `http://${baseUrl}`;

      // Then construct the full URL
      url = `${baseWithProtocol}/${pathString}`;

      // Validate the URL to ensure it's properly formatted
      try {
        new URL(url); // This will throw if the URL is invalid
        console.log(`[Server Proxy] Valid group URL constructed: ${url}`);
      } catch (error) {
        console.error(`[Server Proxy] Invalid group URL detected: ${url}`);
        // Attempt to fix the URL if possible
        url = ensureValidUrl(`${baseWithProtocol}/${pathString}`);
        console.log(`[Server Proxy] Corrected group URL: ${url}`);
      }
    } else {
      // Simplified URL construction for all other cases
      const baseWithProtocol =
        baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
          ? baseUrl
          : `http://${baseUrl}`;

      url = `${baseWithProtocol}/${pathString}`;
      console.log(
        `[Server Proxy] Generic URL construction: baseUrl=${baseUrl}, pathString=${pathString}, final URL=${url}`
      );
    }

    // Add query parameters if present (but only if not already handled in special cases)
    const alreadyHasQueryParams = url.includes("?");
    if (!alreadyHasQueryParams) {
      const queryString = new URLSearchParams(
        query as Record<string, string>
      ).toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    console.log(`[Server Proxy] Forwarding to: ${url}`);

    // Special logging for media requests
    if (pathString.includes("media")) {
      console.log(`[Server Proxy] MEDIA REQUEST DETAILS:`);
      console.log(`[Server Proxy] - Original path string: ${pathString}`);
      console.log(`[Server Proxy] - Base URL: ${baseUrl}`);
      console.log(`[Server Proxy] - Final URL: ${url}`);
      console.log(`[Server Proxy] - Method: ${forcedMethod}`);
    }

    // Special logging for messages/history requests
    if (pathString.includes("messages/history")) {
      console.log(`[Server Proxy] MESSAGES/HISTORY REQUEST DETAILS:`);
      console.log(`[Server Proxy] - Base URL: ${baseUrl}`);
      console.log(`[Server Proxy] - Path: ${pathString}`);
      console.log(`[Server Proxy] - Query params:`, query);
      console.log(`[Server Proxy] - Final URL before validation: ${url}`);
      console.log(`[Server Proxy] - Method: ${forcedMethod}`);

      // Extra validation for messages/history endpoint
      try {
        new URL(url);
      } catch (error) {
        console.error(
          `[Server Proxy] Invalid URL for messages/history: ${url}`
        );
        // Try to fix the URL by ensuring it has a protocol and fixing any double slashes
        let fixedUrl = url;

        // Ensure protocol exists
        if (
          !fixedUrl.startsWith("http://") &&
          !fixedUrl.startsWith("https://")
        ) {
          fixedUrl = `http://${fixedUrl}`;
        }

        // Fix any double slashes that aren't part of the protocol
        fixedUrl = fixedUrl.replace(/([^:]\/)\/+/g, "$1");

        // Update the URL
        url = fixedUrl;
        console.log(`[Server Proxy] Fixed messages/history URL: ${url}`);
      }
    }

    // Build headers
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Create request options object
    const options: EnhancedRequestInit = {
      method: forcedMethod,
      headers,
      credentials: "include", // For CORS
    };

    // Forward authorization header if present
    if (requestHeaders.authorization) {
      console.log("[Server Proxy] Forwarding Authorization header");

      // Ensure the token has the Bearer prefix for all services
      const token = requestHeaders.authorization.startsWith("Bearer ")
        ? requestHeaders.authorization
        : `Bearer ${requestHeaders.authorization}`;

      headers["Authorization"] = token;

      if (pathString.startsWith("notifications")) {
        console.log(
          "[Server Proxy] Using Bearer format for notifications service"
        );
      } else {
        console.log(
          "[Server Proxy] Formatted token with 'Bearer' prefix for standard API"
        );
      }
    } else if (requestHeaders.cookie && !isAuthEndpoint) {
      // Try to extract token from cookies if no authorization header AND NOT an auth endpoint
      console.log("[Server Proxy] Checking cookies for auth token");
      const cookieStr = requestHeaders.cookie;
      const cookies = cookieStr.split(";").reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split("=");
        acc[key] = value;
        return acc;
      }, {} as Record<string, string>);

      if (cookies.auth_token) {
        console.log("[Server Proxy] Found auth_token in cookies");

        // Use Bearer prefix for all services including notifications
        headers["Authorization"] = `Bearer ${cookies.auth_token}`;
        console.log("[Server Proxy] Added Bearer prefix to auth_token");
      } else {
        console.log("[Server Proxy] No auth_token found in cookies");
      }
    } else {
      if (isAuthEndpoint) {
        console.log(
          "[Server Proxy] Auth endpoint detected - skipping token extraction"
        );
      } else {
        console.log("[Server Proxy] No authentication credentials found");
      }
    }

    // Handle request body based on HTTP method and content type
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      // Check if this is a file upload (multipart/form-data)
      if (requestHeaders["content-type"]?.includes("multipart/form-data")) {
        console.log(
          `[Server Proxy] File upload detected using method ${method}, path: ${pathString}, using special handling`
        );

        // For file uploads, we need to completely bypass the H3 request body parsing
        // and directly pass the request to the target server
        try {
          // Create a new server proxy request using native node fetch
          const targetUrl = new URL(url);

          // Return directly through sendProxy which will properly handle streaming the request
          console.log(
            "[Server Proxy] Authorization header:",
            headers.Authorization
          );

          // Create headers object for proxy request
          const proxyHeaders: Record<string, string> = {};

          // Explicitly add Authorization header with proper format
          if (headers.Authorization) {
            proxyHeaders.Authorization = headers.Authorization;
            console.log(
              "[Server Proxy] Added Authorization header:",
              proxyHeaders.Authorization
            );
          } else if (requestHeaders.authorization) {
            // If Authorization header is in original request but not in headers object
            proxyHeaders.Authorization =
              requestHeaders.authorization.startsWith("Bearer ")
                ? requestHeaders.authorization
                : `Bearer ${requestHeaders.authorization}`;
            console.log(
              "[Server Proxy] Added Authorization from request headers:",
              proxyHeaders.Authorization
            );
          } else if (requestHeaders.cookie) {
            // Try to extract from cookies
            const cookieStr = requestHeaders.cookie;
            const cookies = cookieStr.split(";").reduce((acc, cookie) => {
              const [key, value] = cookie.trim().split("=");
              acc[key] = value;
              return acc;
            }, {} as Record<string, string>);

            if (cookies.auth_token) {
              proxyHeaders.Authorization = `Bearer ${cookies.auth_token}`;
              console.log(
                "[Server Proxy] Added Authorization from cookies:",
                proxyHeaders.Authorization
              );
            }
          }

          // Add other headers except content-type and content-length which will be set by the browser
          Object.entries(requestHeaders).forEach(([key, value]) => {
            const lowerKey = key.toLowerCase();
            if (
              lowerKey !== "content-type" &&
              lowerKey !== "content-length" &&
              lowerKey !== "authorization"
            ) {
              // Make sure value is a string to satisfy TypeScript
              if (value !== undefined) {
                proxyHeaders[key] = value.toString();
              }
            }
          });

          return sendProxy(event, targetUrl.toString(), {
            // Forward necessary headers but NOT content-type (browser will set it with proper boundary)
            headers: proxyHeaders,
          });
        } catch (error) {
          console.error("[Server Proxy] Error proxying file upload:", error);
          throw new Error("Failed to proxy file upload");
        }
      } else {
        // Regular JSON handling for methods that have a body
        try {
          const body = await readBody(event);
          if (body !== undefined && body !== null) {
            options.body = JSON.stringify(body);

            // Log request body for auth endpoints with protected password
            if (isAuthEndpoint && body.email) {
              console.log("[Server Proxy] Request body:", {
                ...body,
                password: body.password ? "********" : undefined,
              });

              // Check for common email typos and log warnings
              if (body.email.includes("@gmail.coma")) {
                console.warn(
                  "[Server Proxy] WARNING: Email contains typo - @gmail.coma instead of @gmail.com"
                );
              } else if (body.email.endsWith(".coma")) {
                console.warn(
                  "[Server Proxy] WARNING: Email contains typo - domain ends with .coma instead of .com"
                );
              } else if (body.email.includes(".con")) {
                console.warn(
                  "[Server Proxy] WARNING: Email contains typo - .con instead of .com"
                );
              }
            }
          }
        } catch (error) {
          console.error("[Server Proxy] Error reading JSON body:", error);
          throw new Error("Failed to process request body");
        }
      }
    } else {
      // For GET, HEAD, OPTIONS methods - don't try to read the body
      console.log(`[Server Proxy] Skipping body parsing for ${method} request`);
    }

    // Validate token except for auth endpoints
    if (!isAuthEndpoint) {
      // Use the token from the headers object that we've already set up
      const authHeader = headers["Authorization"] as string;
      const token = authHeader?.replace("Bearer ", "");

      if (!validateToken(token)) {
        console.error(
          "[Server Proxy] Token validation failed with token:",
          token ? `${token.substring(0, 10)}...` : "undefined"
        );
        // Instead of returning an error, just log it but continue with the request
        // This allows the backend to handle the authentication
        console.error(
          "[Server Proxy] Proceeding with request despite invalid token"
        );
      } else {
        console.log("[Server Proxy] Token validation successful");
      }
    } else {
      console.log("[Server Proxy] Skipping token validation for auth endpoint");
    }

    // Simple URL validation before making the request
    try {
      new URL(url);
      console.log(`[Server Proxy] URL validation successful: ${url}`);
    } catch (error) {
      console.error(`[Server Proxy] Invalid URL detected: ${url}`);
      throw new Error(`Cannot create a valid URL: ${url}`);
    }

    // Log detailed request information for debugging
    console.log(`[Server Proxy] Making ${options.method} request to: ${url}`);
    console.log(`[Server Proxy] Headers:`, headers);

    // Make the request to the backend API
    const response = await fetch(url, options);

    console.log(
      `[Server Proxy] Backend response status: ${response.status} from ${url}`
    );

    // Handle error responses by returning status code and message
    if (!response.ok) {
      console.error(
        `[Server Proxy] Error from backend: ${response.status} ${response.statusText}`
      );

      // Try to get error details
      let errorBody;
      try {
        const contentType = response.headers.get("content-type");
        console.log("[Server Proxy] Error response content type:", contentType);

        if (contentType && contentType.includes("application/json")) {
          errorBody = await response.json();
          console.log(
            "[Server Proxy] Detailed error from backend:",
            JSON.stringify(errorBody, null, 2)
          );
        } else {
          errorBody = await response.text();
          console.log("[Server Proxy] Error text from backend:", errorBody);
        }
      } catch (e) {
        console.error("[Server Proxy] Error parsing error response:", e);
        errorBody = "Error parsing response";
      }

      // Return error with proper status code
      event.node.res.statusCode = response.status;

      if (typeof errorBody === "string") {
        return {
          error: true,
          message: errorBody,
          status: response.status,
          statusText: response.statusText,
        };
      }

      return {
        ...errorBody,
        status: response.status,
        statusText: response.statusText,
      };
    }

    // Special handling for file downloads
    const contentType = response.headers.get("content-type");
    const isFileDownload =
      isFileRequest &&
      pathString.includes("/files/") &&
      method === "GET" &&
      contentType &&
      !contentType.includes("application/json");

    if (isFileDownload) {
      // For file downloads, return the raw response
      console.log(
        `[Server Proxy] File download detected (${contentType}), streaming response`
      );

      // Copy all headers from the backend response
      for (const [key, value] of response.headers.entries()) {
        event.node.res.setHeader(key, value);
      }

      // Stream the response as binary data
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    }

    // Read response based on content type
    let responseData;

    try {
      if (contentType && contentType.includes("application/json")) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }
    } catch (e) {
      console.error("[Server Proxy] Error parsing response:", e);
      responseData = { error: "Failed to parse response" };
    }

    // Return the response - Nuxt will handle setting the status code
    return responseData;
  } catch (error: any) {
    console.error("[Server Proxy] Error:", error.message);
    return {
      error: "Proxy Error",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    };
  }
});
