/*
 * SynthOrg: the section under the editor closes like the columns beside it.
 *
 * The columns of a project's frame are not taken away when they are closed:
 * they fold to a strip with the button that opens them again. The panel does
 * the same — folded, it is its title alone, the tabs and the button — so that
 * it never has to be looked for in a menu. What draws the button and remembers
 * the choice is synthorgFrame.contribution.ts; the panel only has to be as
 * tall as its title while it is folded, and to say so to the layout's grid.
 */
export const panelFold: {
	/** Folded to its title: the grid gives the panel that height and no more. */
	folded: boolean;
	/** The height of the title, in CSS pixels. */
	title: number;
	/** Tells the grid that what the panel may be has changed, with the height it asks for (none: what fits); set by the panel. */
	resize: ((height?: number) => void) | null;
} = {
	folded: false,
	title: 35,
	resize: null
};
