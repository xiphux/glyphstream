<!--
	Test harness that wraps BaseDialog with a static body snippet so
	@testing-library/svelte can render it via props alone. The library
	can't pass Snippets through render(), so this file provides one
	inline.
-->
<script lang="ts">
	import BaseDialog from '$lib/components/BaseDialog.svelte';

	let {
		open = false,
		onCancel = () => {},
		titleId = 'test-dialog-title',
		title = 'Test dialog',
		bodyText = 'Test body',
	}: {
		open?: boolean;
		onCancel?: () => void;
		titleId?: string;
		title?: string;
		bodyText?: string;
	} = $props();
</script>

<BaseDialog {open} {onCancel} {titleId} {title}>
	<p>{bodyText}</p>
</BaseDialog>
