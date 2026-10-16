/** Thrown by contract stubs that a builder has not filled in yet. */
export class NotImplementedError extends Error {
	constructor(what: string) {
		super(`not implemented: ${what}`);
		this.name = "NotImplementedError";
	}
}

export function notImplemented(what: string): never {
	throw new NotImplementedError(what);
}
