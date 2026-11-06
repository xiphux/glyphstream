import { describe, expect, it } from 'vitest';
import {
	lastSceneIn,
	lastSceneInParts,
	sceneMarker,
	sceneMarkerText,
	withoutSceneMarkers,
} from '#lib/scenes.js';

describe('sceneMarker', () => {
	it.each([
		['[texting]', 'texting'],
		['[in person]', 'in_person'],
		['[In-Person]', 'in_person'],
		['*[in person]*', 'in_person'],
		['**[texting]**', 'texting'],
	] as const)('reads %s', (text, scene) => {
		expect(sceneMarker({ text })).toBe(scene);
	});

	it('reads the rendered html the same way', () => {
		expect(sceneMarker({ html: '<p>[in person]</p>' })).toBe('in_person');
		expect(sceneMarker({ html: '<p><em>[texting]</em></p>' })).toBe('texting');
	});

	it.each(['[in person] hi', 'we met [in person]', '[at the park]', '[texting'])(
		'leaves %s as words',
		(text) => {
			expect(sceneMarker({ text })).toBeNull();
		},
	);

	it('writes the marker it reads', () => {
		expect(sceneMarker({ text: sceneMarkerText('in_person') })).toBe('in_person');
		expect(sceneMarker({ text: sceneMarkerText('texting') })).toBe('texting');
	});
});

describe('lastSceneIn', () => {
	it('takes the last marker, paragraph by paragraph', () => {
		expect(lastSceneIn('omw\n\n[in person]\n\nhey\n\n[texting]\n\nhome safe')).toBe('texting');
		expect(lastSceneIn('just text')).toBeNull();
		// A marker sharing a paragraph isn't one.
		expect(lastSceneIn('hey\n[in person]')).toBeNull();
	});

	it('reads across a message’s text parts and skips the rest', () => {
		expect(
			lastSceneInParts([
				{ type: 'text', text: '[in person]' },
				{ type: 'image', mediaId: 'm' } as never,
				{ type: 'text', text: 'see you\n\n[texting]' },
			]),
		).toBe('texting');
	});
});

it('withoutSceneMarkers drops only the markers', () => {
	expect(withoutSceneMarkers('[in person]\n\n*knocks*\n\nhi')).toBe('*knocks*\n\nhi');
});
