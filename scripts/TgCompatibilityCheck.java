import app.tuxguitar.io.base.TGSongReaderHandle;
import app.tuxguitar.io.tg.TGSongReaderImpl;
import app.tuxguitar.song.factory.TGFactory;
import app.tuxguitar.song.models.*;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Iterator;

// Compile against the unmodified official TuxGuitar sources in licenses/.
public class TgCompatibilityCheck {
  public static void main(String[] paths) throws Exception {
    for(String file:paths) {
      TGSongReaderHandle handle=new TGSongReaderHandle();handle.setFactory(new TGFactory());handle.setInputStream(new FileInputStream(file));
      new TGSongReaderImpl().read(handle);TGSong song=handle.getSong();
      int notes=0,tracks=0;Iterator<TGTrack> tt=song.getTracks();
      while(tt.hasNext()) {TGTrack track=tt.next();tracks++;Iterator<TGMeasure> mm=track.getMeasures();
        while(mm.hasNext())for(TGBeat beat:mm.next().getBeats()) {
          if(beat.getPreciseStart()<TGDuration.getPreciseStartingPoint())throw new AssertionError("Invalid beat start");
          for(int i=0;i<TGBeat.MAX_VOICES;i++) {TGVoice voice=beat.getVoice(i);if(voice.getDuration().getPreciseTime()<=0)throw new AssertionError("Invalid duration");notes+=voice.getNotes().size();
            for(TGNote note:voice.getNotes())if(note.getString()<1||note.getString()>track.getStrings().size())throw new AssertionError("Invalid string");
          }
        }
      }
      if(TGDuration.getPreciseStartingPoint()!=2882880)throw new AssertionError("Incorrect TG precision unit");
      System.out.println(Base64.getEncoder().encodeToString(song.getName().getBytes(StandardCharsets.UTF_8))+"\t"+song.countMeasureHeaders()+"\t"+notes+"\t"+tracks);
    }
  }
}
