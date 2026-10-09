#!/bin/zsh
# mux.sh — lays a music bed under the silent film (out/river-silent.mp4), locked to the film's bar grid.
#
# film.html cuts on whole bars of 88 BPM (BAR = 2.727 s). Each track below is trimmed so that one of its downbeats
# falls on the film's first frame (and, for B, so that its drop lands where the music comes back), and nudged with
# atempo to 88 BPM when it is not already there (≤ 2%, inaudible). At the cut from the noise into "You don't have
# to." the music goes silent for one bar and returns over the next. Mixed quiet (−20 LUFS): a bed, not the lead.
#
#   ./mux.sh a        # → out/river-a-flowing.mp4
#   ./mux.sh b        # → out/river-b-garage.mp4
#
# Tracks are Pixabay Content License (commercial use, no attribution required; neither is Content ID registered).
# Credit anyway in the video description:
#   A  "ChillStep Flowing Background" by Brotheration_Records  pixabay.com/music/upbeat-chillstep-flowing-background-165674/
#   B  "Deep Melodic Garage" by soundoffreedom                   pixabay.com/music/electronic-deep-melodic-garage-465157/
set -euo pipefail
cd "${0:A:h}"
case "${1:-a}" in
  a) NAME=flowing URL=https://cdn.pixabay.com/audio/2023/09/08/audio_efc01f29b9.mp3 BPM=88.00 OFF=25.095 ;;  # downbeat 0.55 s + 9 bars
  b) NAME=garage  URL=https://cdn.pixabay.com/audio/2026/01/13/audio_1021be955b.mp3 BPM=86.65 OFF=21.47 ;;  # drop (29.78 s) on the return
  *) echo "usage: mux.sh a|b" >&2; exit 1 ;;
esac
BAR=$(( 240.0 / 88 )); CUT=$(( 2 * BAR )); BACK=$(( 3 * BAR )); RATE=$(( 88 / BPM ))
mkdir -p music out
TRACK=music/$NAME.mp3
[[ -f $TRACK ]] || curl -sfL -A "Mozilla/5.0" -e https://pixabay.com/ -o $TRACK $URL
V=out/river-silent.mp4
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $V)
BED="atrim=start=$OFF,asetpts=PTS-STARTPTS,atempo=$RATE,atrim=0:$D,volume='if(lt(t,$CUT),1,if(lt(t,$BACK),0,min(1,(t-$BACK)/$BAR)))':eval=frame,afade=t=in:d=0.3,afade=t=out:st=$(( D - 3.5 )):d=3.5"
# two passes: measure the bed's loudness, then apply one fixed gain to −20 LUFS (no pumping at the silent bar)
I=$(ffmpeg -nostats -v info -i $TRACK -af "$BED,ebur128" -f null - 2>&1 | awk '/^ +I:/{v=$2} END{print v}')
ffmpeg -v error -y -i $V -i $TRACK -filter_complex "[1:a]$BED,volume=$(( -20 - I ))dB,alimiter=limit=0.89,aresample=48000[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart out/river-$1-$NAME.mp4
echo "out/river-$1-$NAME.mp4  (bed measured ${I} LUFS → −20)"
