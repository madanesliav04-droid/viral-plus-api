import React from 'react';
import {Composition} from 'remotion';
import {EditPlusVertical} from './EditPlusVertical.jsx';

const fps=30;

const durationFromProps=({props})=>{
  const segments=Array.isArray(props?.timeline?.segments)?props.timeline.segments:[];
  const durationMs=segments.reduce((sum,segment)=>{
    const start=Number(segment?.sourceStartMs||0);
    const end=Number(segment?.sourceEndMs||start);
    return sum+Math.max(0,end-start);
  },0);
  return {
    durationInFrames:Math.max(1,Math.ceil((durationMs/1000)*fps)),
    width:Number(props?.width||1080),
    height:Number(props?.height||1920),
    fps:Number(props?.fps||fps)
  };
};

export const Root=()=>(
  <Composition
    id="EditPlusVertical"
    component={EditPlusVertical}
    durationInFrames={30}
    fps={fps}
    width={1080}
    height={1920}
    calculateMetadata={durationFromProps}
    defaultProps={{
      sourceUrl:'',
      style:'creator_clean',
      captionPreset:'modern_bold',
      accentColor:'#d7ff3f',
      timeline:{version:1,segments:[],captions:[],overlays:[]}
    }}
  />
);
