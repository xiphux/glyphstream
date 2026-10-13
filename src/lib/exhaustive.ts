/**
 * Compile-time exhaustiveness for a `switch` over a discriminated union: put
 * `default: unhandled(x)` last, and adding a variant without a case becomes a
 * type error ("not assignable to never") instead of a silent drop.
 *
 * Deliberately a no-op at runtime. A client meeting a stream event from a newer
 * server, or a row written by a newer build, should skip what it doesn't know,
 * not throw.
 */
export function unhandled(value: never): void {
	void value;
}
