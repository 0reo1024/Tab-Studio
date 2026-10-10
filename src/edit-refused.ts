/** An edit refused before it changed anything (a rest too short, a fret out of range, no
 * note selected). The edit transaction then only shows the message: nothing needs to be
 * restored or drawn again. */
export class EditRefused extends Error{}
