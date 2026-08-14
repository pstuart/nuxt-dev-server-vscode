/** Valid TCP port range: 1-65535 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Valid PID must be a positive integer */
export function isValidPid(value: number): boolean {
    return Number.isInteger(value) && value > 0;
}

/** Valid TCP port must be in range 1-65535 */
export function isValidPort(value: number): boolean {
    return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/**
 * Safely parse and validate a string as a PID
 * @param value String representation of a PID
 * @returns Validated PID number or throws Error
 */
export function parsePid(value: string): number {
    const trimmed = value.trim();
    const parsed = parseInt(trimmed, 10);

    // Ensure the parsed value matches the string exactly (no decimals, no trailing chars)
    if (trimmed !== String(parsed)) {
        throw new Error(`Invalid PID value: "${value}". Must be a positive integer.`);
    }

    if (!isValidPid(parsed)) {
        throw new Error(`Invalid PID value: "${value}". Must be a positive integer.`);
    }

    return parsed;
}

/**
 * Safely parse and validate a string as a TCP port
 * @param value String representation of a port
 * @returns Validated port number or throws Error
 */
export function parsePort(value: string): number {
    const trimmed = value.trim();
    const parsed = parseInt(trimmed, 10);

    // Ensure the parsed value matches the string exactly (no decimals, no trailing chars)
    if (trimmed !== String(parsed)) {
        throw new Error(`Invalid port value: "${value}". Must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    }

    if (!isValidPort(parsed)) {
        throw new Error(`Invalid port value: "${value}". Must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    }

    return parsed;
}

/**
 * Clamp a number to a valid port range
 * @param value Input number
 * @returns Clamped port in range 1-65535, or null if invalid input
 */
export function clampPort(value: number): number | null {
    if (!Number.isFinite(value)) {
        return null;
    }
    return Math.max(MIN_PORT, Math.min(MAX_PORT, Math.floor(value)));
}

/**
 * Type guard to narrow unknown to a valid PID number
 */
export function isPidNumber(value: unknown): value is number {
    return typeof value === 'number' && isValidPid(value);
}

/**
 * Type guard to narrow unknown to a valid port number
 */
export function isPortNumber(value: unknown): value is number {
    return typeof value === 'number' && isValidPort(value);
}
