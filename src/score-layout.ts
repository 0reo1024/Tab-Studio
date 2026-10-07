import {SystemsLayoutMode} from '@coderline/alphatab';

// Let the notation engine measure fret numbers, rhythms and technique glyphs
// before wrapping. A fixed bar count forces dense measures to be compressed.
export const readableLayout={
  barsPerRow:-1,
  stretchForce:1.35,
  systemsLayoutMode:SystemsLayoutMode.Automatic,
  justifyLastSystem:true
};
