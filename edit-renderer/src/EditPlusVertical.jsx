import React from 'react';
import {AbsoluteFill,Img,Sequence,interpolate,useCurrentFrame,useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';

const captionStyles={
  modern_bold:{fontSize:72,fontWeight:900,bottom:'18%',maxWidth:'86%',textTransform:'none',background:'transparent'},
  minimal:{fontSize:54,fontWeight:700,bottom:'14%',maxWidth:'84%',background:'rgba(0,0,0,.42)'},
  creator:{fontSize:64,fontWeight:850,bottom:'17%',maxWidth:'88%',background:'transparent'},
  karaoke:{fontSize:68,fontWeight:900,bottom:'18%',maxWidth:'90%',background:'transparent'},
  authority:{fontSize:52,fontWeight:750,bottom:'12%',maxWidth:'82%',background:'rgba(0,0,0,.36)'},
  ugc:{fontSize:58,fontWeight:800,bottom:'15%',maxWidth:'88%',background:'rgba(0,0,0,.26)'}
};

const cropScale={normal:1,close:1.12,very_close:1.25,wide:.94};

const normalizeSegments=(segments,fps)=>{
  let cursor=0;
  return (segments||[]).map((segment,index)=>{
    const sourceStartMs=Math.max(0,Number(segment.sourceStartMs||0));
    const sourceEndMs=Math.max(sourceStartMs,Number(segment.sourceEndMs||sourceStartMs));
    const durationMs=sourceEndMs-sourceStartMs;
    const durationFrames=Math.max(1,Math.round(durationMs/1000*fps));
    const out={...segment,index,sourceStartMs,sourceEndMs,durationMs,durationFrames,outputStartFrame:cursor};
    cursor+=durationFrames;
    return out;
  });
};

const Segment=({segment,sourceUrl,fps})=>{
  const scale=cropScale[segment.crop]||1;
  const x=Number(segment.positionX||50);
  const y=Number(segment.positionY||50);
  return (
    <Sequence from={segment.outputStartFrame} durationInFrames={segment.durationFrames} name={`Cut ${segment.index+1}`}>
      <AbsoluteFill style={{overflow:'hidden',backgroundColor:'black'}}>
        <Video
          src={sourceUrl}
          trimBefore={Math.round(segment.sourceStartMs/1000*fps)}
          trimAfter={Math.max(Math.round(segment.sourceEndMs/1000*fps),Math.round(segment.sourceStartMs/1000*fps)+1)}
          volume={segment.muted?0:1}
          style={{
            width:'100%',
            height:'100%',
            objectFit:'cover',
            objectPosition:`${x}% ${y}%`,
            scale
          }}
        />
      </AbsoluteFill>
    </Sequence>
  );
};

const CaptionLayer=({captions,preset,accentColor})=>{
  const frame=useCurrentFrame();
  const {fps}=useVideoConfig();
  const now=frame/fps*1000;
  const active=(captions||[]).find(c=>now>=Number(c.startMs||0)&&now<Number(c.endMs||0));
  if(!active)return null;
  const style=captionStyles[preset]||captionStyles.modern_bold;
  const startFrame=Number(active.startMs||0)/1000*fps;
  const entrance=interpolate(frame,[startFrame,startFrame+Math.max(2,fps*.08)],[.94,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
  const words=Array.isArray(active.words)&&active.words.length?active.words:null;

  return (
    <AbsoluteFill style={{pointerEvents:'none'}}>
      <div style={{
        position:'absolute',
        left:'50%',
        bottom:style.bottom,
        translate:'-50% 0',
        width:style.maxWidth,
        textAlign:'center',
        fontFamily:'Inter, Arial, sans-serif',
        fontSize:style.fontSize,
        fontWeight:style.fontWeight,
        lineHeight:1.04,
        letterSpacing:'-0.035em',
        color:'white',
        textShadow:'0 3px 18px rgba(0,0,0,.78)',
        background:style.background,
        borderRadius:18,
        padding:style.background==='transparent'?0:'10px 16px',
        scale:entrance
      }}>
        {words?words.map((word,i)=>{
          const on=now>=Number(word.startMs||0)&&now<Number(word.endMs||0);
          return <span key={i} style={{color:on?accentColor:'white',marginRight:10}}>{word.text}</span>;
        }):active.text}
      </div>
    </AbsoluteFill>
  );
};

const OverlayLayer=({overlays})=>{
  const frame=useCurrentFrame();
  const {fps}=useVideoConfig();
  const now=frame/fps*1000;
  return (overlays||[]).filter(o=>now>=Number(o.startMs||0)&&now<Number(o.endMs||0)&&o.assetUrl).map((overlay,i)=>{
    const common={
      position:'absolute',
      left:overlay.x??0,
      top:overlay.y??0,
      width:overlay.width??'100%',
      height:overlay.height??'100%',
      objectFit:overlay.fit||'cover',
      borderRadius:overlay.radius||0
    };
    if(overlay.type==='video'){
      const localFrame=Math.max(0,frame-Math.round(Number(overlay.startMs||0)/1000*fps));
      return <Video key={i} src={overlay.assetUrl} muted={overlay.muted!==false} trimBefore={Math.max(0,localFrame)} style={common}/>;
    }
    return <Img key={i} src={overlay.assetUrl} style={common}/>;
  });
};

export const EditPlusVertical=({
  sourceUrl,
  timeline,
  captionPreset='modern_bold',
  accentColor='#d7ff3f'
})=>{
  const {fps}=useVideoConfig();
  const segments=normalizeSegments(timeline?.segments||[],fps);
  return (
    <AbsoluteFill style={{backgroundColor:'black'}}>
      {segments.map(segment=><Segment key={segment.index} segment={segment} sourceUrl={sourceUrl} fps={fps}/>)}
      <OverlayLayer overlays={timeline?.overlays||[]}/>
      <CaptionLayer captions={timeline?.captions||[]} preset={captionPreset} accentColor={accentColor}/>
    </AbsoluteFill>
  );
};
