import * as THREE from "three";
import { Parser as MMDParser } from "mmd-parser";

// Alias Three.js classes and constants
const ft = THREE.Vector3;
const et = THREE.MathUtils;
const bi = THREE.BufferAttribute;
const ox = THREE.BufferGeometry;
const rx = THREE.TextureLoader;
const de = THREE.Color;
const ux = THREE.Bone;
const Yg = THREE.Object3D;
const cx = THREE.Skeleton;
const Ce = THREE.Quaternion;
const Kg = THREE.SkinnedMesh;
const Xg = THREE.Box3;
const Rh = THREE.Euler;
const hx = THREE.DataTexture;
const fx = THREE.RGBAFormat; // 1023
const $c = THREE.LinearFilter; // 1006
const np = THREE.ClampToEdgeWrapping; // 1001
const ip = THREE.DoubleSide; // 2
const dx = THREE.FrontSide; // 0
const Pg = THREE.MeshBasicMaterial;
const mx = THREE.MeshToonMaterial;
const Qg = THREE.SRGBColorSpace; // "srgb"
const ap = THREE.RepeatWrapping; // 1000
const px = THREE.LinearMipmapLinearFilter; // 1008
const gx = THREE.LinearSRGBColorSpace; // "srgb-linear"
const yx = THREE.BackSide; // 1
const Zg = THREE.Group;
const Gs = THREE.DirectionalLight;
const vx = THREE.HemisphereLight;
const bx = THREE.Scene;
const nl = THREE.Vector2;
const xx = THREE.WebGLRenderer;
const Sx = THREE.CineonToneMapping; // 3
const wx = THREE.ReinhardToneMapping; // 2
const Tx = THREE.ACESFilmicToneMapping; // 4
const Wg = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping; // 7
const Ax = THREE.NoToneMapping; // 0
const Mx = THREE.PCFSoftShadowMap; // 2
const Ex = THREE.PerspectiveCamera;
const Cx = THREE.Clock;

const lx = MMDParser;

function GS(a){const i=new Float32Array(a*3),s=Math.PI*(3-Math.sqrt(5));for(let o=0;o<a;o++){const r=Math.sqrt(1-(o+.5)/a),h=Math.sqrt(1-r*r),f=o*s;i[o*3]=Math.cos(f)*h,i[o*3+1]=Math.sin(f)*h,i[o*3+2]=r}return i}function YS(a,i={}){const s=i.resolution??96,o=i.samples??24,r=i.rayLength??.03,h=i.smoothPasses??2,f=i.contrast??.85,d=i.minimum??.42,g=a.getAttribute("position"),m=a.getAttribute("normal"),y=a.getIndex();if(!g||!m||!y)return;a.computeBoundingBox();const v=a.boundingBox,S=new ft;v.getSize(S);const T=Math.max(S.x,S.y,S.z)||1,A=T/s,N=Math.max(1,Math.ceil(S.x/A)+2),D=Math.max(1,Math.ceil(S.y/A)+2),_=Math.max(1,Math.ceil(S.z/A)+2),Y=v.min.x-A,X=v.min.y-A,P=v.min.z-A,tt=new Uint8Array(N*D*_),F=(O,I,at)=>(at*D+I)*N+O,k=(O,I,at)=>{const nt=(O-Y)/A|0,ct=(I-X)/A|0,wt=(at-P)/A|0;nt<0||ct<0||wt<0||nt>=N||ct>=D||wt>=_||(tt[F(nt,ct,wt)]=1)},U=y.count/3,W=new ft,$=new ft,ot=new ft;for(let O=0;O<U;O++){const I=y.getX(O*3),at=y.getX(O*3+1),nt=y.getX(O*3+2);W.fromBufferAttribute(g,I),$.fromBufferAttribute(g,at),ot.fromBufferAttribute(g,nt),k(W.x,W.y,W.z),k($.x,$.y,$.z),k(ot.x,ot.y,ot.z);const ct=Math.max(W.distanceTo($),$.distanceTo(ot),ot.distanceTo(W)),wt=Math.min(6,Math.ceil(ct/A));if(!(wt<=1))for(let vt=0;vt<=wt;vt++)for(let Be=0;Be+vt<=wt;Be++){const Se=vt/wt,Re=Be/wt,De=1-Se-Re;k(W.x*Se+$.x*Re+ot.x*De,W.y*Se+$.y*Re+ot.y*De,W.z*Se+$.z*Re+ot.z*De)}}const lt=GS(o),xt=T*r,kt=Math.max(3,Math.round(xt/A)),Nt=xt/kt,B=g.count,Q=new Float32Array(B),J=new ft,st=new ft,dt=new ft,E=new ft,w=new ft;for(let O=0;O<B;O++){st.fromBufferAttribute(g,O),J.fromBufferAttribute(m,O).normalize(),w.set(Math.abs(J.z)<.9?0:1,(Math.abs(J.z)<.9,0),Math.abs(J.z)<.9?1:0),dt.crossVectors(w,J),dt.lengthSq()<1e-8&&dt.set(1,0,0),dt.normalize(),E.crossVectors(J,dt);let I=0;for(let at=0;at<o;at++){const nt=lt[at*3],ct=lt[at*3+1],wt=lt[at*3+2],vt=dt.x*nt+E.x*ct+J.x*wt,Be=dt.y*nt+E.y*ct+J.y*wt,Se=dt.z*nt+E.z*ct+J.z*wt;let Re=0;for(let De=1;De<=kt;De++){const $t=Nt*De+A*.75,En=(st.x+vt*$t-Y)/A|0,ke=(st.y+Be*$t-X)/A|0,Pn=(st.z+Se*$t-P)/A|0;if(En<0||ke<0||Pn<0||En>=N||ke>=D||Pn>=_)break;if(tt[F(En,ke,Pn)]===1){Re=1-(De-1)/kt;break}}I+=Re}Q[O]=1-I/o}if(h>0){const O=new Float32Array(B),I=new Uint16Array(B);for(let at=0;at<h;at++){O.fill(0),I.fill(0);for(let nt=0;nt<U;nt++){const ct=y.getX(nt*3),wt=y.getX(nt*3+1),vt=y.getX(nt*3+2);O[ct]+=Q[wt]+Q[vt],I[ct]+=2,O[wt]+=Q[ct]+Q[vt],I[wt]+=2,O[vt]+=Q[ct]+Q[wt],I[vt]+=2}for(let nt=0;nt<B;nt++)I[nt]!==0&&(Q[nt]=Q[nt]*.45+O[nt]/I[nt]*.55)}}for(let O=0;O<B;O++){const I=Math.pow(et.clamp(Q[O],0,1),f);Q[O]=d+I*(1-d)}a.setAttribute("aoValue",new bi(Q,1))}const KS={IK:32},XS=["kinematic","dynamic","dynamicBonePosition"],PS=["sphere","box","capsule"];function QS(a,i){return a.slice(0,a.lastIndexOf("/")+1)+i.split(/[\\/]/).map(encodeURIComponent).join("/")}function bp(a){const i=new Ce().setFromEuler(new Rh(a[0],a[1],a[2],"XYZ"));return new Ce(-i.x,-i.y,i.z,i.w)}async function ZS(a){const{modelUrl:i,textureMapUrl:s,createMaterial:o,onProgress:r}=a,h=(w,O)=>r==null?void 0:r(w,O);h("Fetching model",0);const[f,d]=await Promise.all([fetch(i).then(w=>{if(!w.ok)throw new Error(`Failed to fetch model: ${w.status} ${i}`);return w.arrayBuffer()}),fetch(s).then(w=>{if(!w.ok)throw new Error(`Failed to fetch texture map: ${w.status} ${s}`);return w.json()})]);h("Parsing model",.15);const g=new lx().parsePmx(f),m=g.metadata.vertexCount,y=g.metadata.faceCount;h("Building geometry",.3);const v=new Float32Array(m*3),S=new Float32Array(m*3),T=new Float32Array(m*2),A=new Uint16Array(m*4),N=new Float32Array(m*4);for(let w=0;w<m;w++){const O=g.vertices[w];v[w*3]=O.position[0],v[w*3+1]=O.position[1],v[w*3+2]=-O.position[2],S[w*3]=O.normal[0],S[w*3+1]=O.normal[1],S[w*3+2]=-O.normal[2],T[w*2]=O.uv[0],T[w*2+1]=1-O.uv[1];const I=O.skinIndices,at=O.skinWeights;for(let ct=0;ct<4;ct++)A[w*4+ct]=ct<I.length?I[ct]:0,N[w*4+ct]=ct<at.length?at[ct]:0;const nt=N[w*4]+N[w*4+1]+N[w*4+2]+N[w*4+3];if(nt>0&&Math.abs(nt-1)>1e-4)for(let ct=0;ct<4;ct++)N[w*4+ct]/=nt}const D=new Uint32Array(y*3);for(let w=0;w<y;w++){const O=g.faces[w].indices;D[w*3]=O[0],D[w*3+1]=O[1],D[w*3+2]=O[2]}const _=new ox;_.setAttribute("position",new bi(v,3)),_.setAttribute("normal",new bi(S,3)),_.setAttribute("uv",new bi(T,2)),_.setAttribute("skinIndex",new bi(A,4)),_.setAttribute("skinWeight",new bi(N,4)),_.setIndex(new bi(D,1)),h("Loading textures",.45);const Y=new rx,X=g.textures.map(w=>{const O=d.textures[w];return O?QS(s,O):null}),P=w=>w>=0&&w<X.length?X[w]:null,tt=[],F=[];let k=0;g.materials.forEach((w,O)=>{_.addGroup(k,w.faceCount*3,O),tt.push({index:O,name:w.name,start:k,count:w.faceCount*3,edgeSize:w.edgeSize,edgeColor:new de(w.edgeColor[0],w.edgeColor[1],w.edgeColor[2]),flag:w.flag}),k+=w.faceCount*3,F.push(o({index:O,name:w.name,diffuse:w.diffuse,specular:w.specular,shininess:w.shininess,ambient:w.ambient,flag:w.flag,edgeColor:w.edgeColor,edgeSize:w.edgeSize,mapUrl:P(w.textureIndex),toonUrl:w.toonFlag===0?P(w.toonIndex):null,sphereUrl:P(w.envTextureIndex),sphereMode:w.envFlag},Y))}),h("Building skeleton",.6);const U=[],W=[],$=new Map;g.bones.forEach((w,O)=>{const I=new ft(w.position[0],w.position[1],-w.position[2]);U.push({index:O,name:w.name,parentIndex:w.parentIndex,position:I,flag:w.flag,transformationClass:w.transformationClass??0,ik:w.ik?{effectorIndex:w.ik.effector,iteration:w.ik.iteration,maxAngle:w.ik.maxAngle,links:w.ik.links.map(nt=>({boneIndex:nt.index,limited:nt.angleLimitation===1,lower:nt.lowerLimitationAngle?new ft(-nt.upperLimitationAngle[0],-nt.upperLimitationAngle[1],nt.lowerLimitationAngle[2]):void 0,upper:nt.upperLimitationAngle?new ft(-nt.lowerLimitationAngle[0],-nt.lowerLimitationAngle[1],nt.upperLimitationAngle[2]):void 0}))}:void 0,grant:w.grant?{parentIndex:w.grant.parentIndex,ratio:w.grant.ratio,affectRotation:!!w.grant.affectRotation,affectPosition:!!w.grant.affectPosition,isLocal:!!w.grant.isLocal}:void 0});const at=new ux;at.name=w.name,W.push(at),$.has(w.name)||$.set(w.name,O)});const ot=new Yg;U.forEach((w,O)=>{const I=W[O];w.parentIndex>=0&&w.parentIndex<W.length?(W[w.parentIndex].add(I),I.position.subVectors(w.position,U[w.parentIndex].position)):(ot.add(I),I.position.copy(w.position))}),ot.updateMatrixWorld(!0);const lt=new cx(W);h("Building morphs",.75);const xt=new Map,kt=new Map,Nt=new Map,B=[];g.morphs.forEach(w=>{switch(w.type){case 1:{const O=new Float32Array(m*3);for(const at of w.elements)O[at.index*3]=at.position[0],O[at.index*3+1]=at.position[1],O[at.index*3+2]=-at.position[2];const I=new bi(O,3);I.name=w.name,xt.set(w.name,{name:w.name,panel:w.panel,morphTargetIndex:B.length}),B.push(I);break}case 2:{kt.set(w.name,{name:w.name,panel:w.panel,elements:w.elements.map(O=>({boneIndex:O.index,position:new ft(O.position[0],O.position[1],-O.position[2]),rotation:new Ce(-O.rotation[0],-O.rotation[1],O.rotation[2],O.rotation[3])}))});break}case 0:{Nt.set(w.name,{name:w.name,panel:w.panel,elements:w.elements.map(O=>{var I;return{morphName:((I=g.morphs[O.index])==null?void 0:I.name)??"",ratio:O.ratio}})});break}}}),B.length>0&&(_.morphAttributes.position=B,_.morphTargetsRelative=!0);const Q=new Kg(_,F);Q.name=g.metadata.modelName||"character",Q.normalizeSkinWeights(),Q.add(ot),Q.bind(lt),Q.frustumCulled=!1,Q.morphTargetDictionary={},Q.morphTargetInfluences=new Array(B.length).fill(0),xt.forEach(w=>{Q.morphTargetDictionary[w.name]=w.morphTargetIndex}),_.computeBoundingBox(),_.computeBoundingSphere(),h("Baking ambient occlusion",.85),YS(_),h("Reading physics",.9);const J=g.rigidBodies.map((w,O)=>({index:O,name:w.name,boneIndex:w.boneIndex,groupIndex:w.groupIndex,groupTarget:w.groupTarget,shape:PS[w.shapeType]??"capsule",size:new ft(w.width,w.height,w.depth),position:new ft(w.position[0],w.position[1],-w.position[2]),rotation:bp(w.rotation),mass:w.weight,positionDamping:w.positionDamping,rotationDamping:w.rotationDamping,restitution:w.restitution,friction:w.friction,type:XS[w.type]??"kinematic"})),st=g.constraints.map((w,O)=>({index:O,name:w.name,bodyA:w.rigidBodyIndex1,bodyB:w.rigidBodyIndex2,position:new ft(w.position[0],w.position[1],-w.position[2]),rotation:bp(w.rotation),rotationLower:new ft(-w.rotationLimitation2[0],-w.rotationLimitation2[1],w.rotationLimitation1[2]),rotationUpper:new ft(-w.rotationLimitation1[0],-w.rotationLimitation1[1],w.rotationLimitation2[2]),springRotation:new ft(w.springRotation[0],w.springRotation[1],w.springRotation[2])})),dt=U.filter(w=>w.ik&&(w.flag&KS.IK)!==0).map(w=>({boneIndex:w.index,info:w.ik})),E=U.filter(w=>w.grant).map(w=>({boneIndex:w.index,info:w.grant}));return h("Ready",1),{name:g.metadata.modelName,mesh:Q,skeleton:lt,bones:W,boneInfos:U,boneIndexByName:$,materials:tt,vertexMorphs:xt,boneMorphs:kt,groupMorphs:Nt,rigidBodies:J,constraints:st,iks:dt,grants:E,boundingBox:_.boundingBox??new Xg}}const Bo=128,xp=new Map;function WS(a){let i=xp.get(a);return i||(i=new Promise((s,o)=>{const r=new Image;r.crossOrigin="anonymous",r.onload=()=>s(r),r.onerror=()=>o(new Error(`Failed to load toon ramp: ${a}`)),r.src=a}),xp.set(a,i)),i}function Qs(a){const i=new Float32Array(Bo).fill(1);return ay(i,{...a,terminator:0})}async function IS(a,i){if(!a)return Qs(i);let s;try{s=await WS(a)}catch{return Qs(i)}const o=s.naturalWidth||32,r=s.naturalHeight||32,h=document.createElement("canvas");h.width=o,h.height=r;const f=h.getContext("2d",{willReadFrequently:!0});if(!f)return Qs(i);f.drawImage(s,0,0);let d;try{d=f.getImageData(0,0,o,r).data}catch{return Qs(i)}const g=new Float32Array(Bo);for(let m=0;m<Bo;m++){const y=m/(Bo-1),v=Math.min(r-1,Math.round((1-y)*(r-1)));let S=0,T=0;for(let A=0;A<5;A++){const N=Math.min(o-1,Math.round((A+.5)/5*(o-1))),D=(v*o+N)*4;S+=(d[D]*.2126+d[D+1]*.7152+d[D+2]*.0722)/255,T++}g[m]=S/T}return ay(g,i)}function ay(a,i){const s=a.length,o=Math.max(0,Math.round(i.terminator??6));let r=a;if(o>0){const S=new Float32Array(s);for(let T=0;T<s;T++){let A=0,N=0;for(let D=-o;D<=o;D++){const _=et.clamp(T+D,0,s-1),Y=Math.exp(-(D*D)/(2*(o/2)**2||1));A+=r[_]*Y,N+=Y}S[T]=A/N}r=S}let h=1/0,f=-1/0;for(let S=0;S<s;S++)r[S]<h&&(h=r[S]),r[S]>f&&(f=r[S]);const d=f-h,m=.06+et.clamp(i.softness,0,1)*.34,y=new Uint8Array(s*4);for(let S=0;S<s;S++){const T=S/(s-1),A=d>.02?(r[S]-h)/d:1,N=et.smoothstep(T,.5-m,.5+m),D=d>.02?A*.65+N*.35:N,_=Math.round(et.clamp(D,0,1)*255);y[S*4]=_,y[S*4+1]=_,y[S*4+2]=_,y[S*4+3]=255}const v=new hx(y,s,1,fx);return v.minFilter=$c,v.magFilter=$c,v.wrapS=np,v.wrapT=np,v.generateMipmaps=!1,v.needsUpdate=!0,v}const re={uKeyDirView:{value:new ft(0,0,1)},uFillDirView:{value:new ft(0,0,1)},uRimDirView:{value:new ft(0,0,-1)},uHairDirView:{value:new ft(0,1,0)},uUpView:{value:new ft(0,1,0)},uKeyColor:{value:new de(1,1,1)},uFillColor:{value:new de(1,1,1)},uRimLightColor:{value:new de(1,1,1)},uHairLightColor:{value:new de(1,1,1)},uAmbientSky:{value:new de(1,1,1)},uAmbientGround:{value:new de(1,1,1)},uFillLevel:{value:.2},uAmbientLevel:{value:.15},uRimLevel:{value:.14},uHairLevel:{value:.1},uFrontFillLevel:{value:.22},uFrontFillColor:{value:new de(1,1,1)},uFaceKeyDirView:{value:new ft(-.36,.31,.88)},uFaceKeyColor:{value:new de(1,1,1)},uFaceTopDirView:{value:new ft(0,.94,.33)},uFaceTopColor:{value:new de(1,1,1)},uFaceRimDirView:{value:new ft(.5,.35,-.79)},uFaceRimColor:{value:new de(1,1,1)},uFaceBounceColor:{value:new de(1,1,1)},uFaceFillColor:{value:new de(1,1,1)},uFaceKeyLevel:{value:.62},uFaceFillLevel:{value:.4},uFaceTopLevel:{value:.18},uFaceRimLevel:{value:.16},uFaceBounceLevel:{value:.2}};function Do(a){return new de().setHex(a,gx)}const sn={shadingSoftness:.6,shadowStrength:.38,rimStrength:.35,rimPower:3,rimColor:16777215,specularStrength:.1,specularPower:24,emissiveStrength:0},JS={DoubleSided:1};function Sp(a,i){return a.colorSpace=Qg,a.anisotropy=i,a.wrapS=ap,a.wrapT=ap,a.generateMipmaps=!0,a.minFilter=px,a.magFilter=$c,a}function $S(a,i,s,o,r,h=!0){const f=h?ip:(a.flag&JS.DoubleSided)!==0?ip:dx,d=a.mapUrl?Sp(o.load(a.mapUrl),r):null,g=new de(a.diffuse[0],a.diffuse[1],a.diffuse[2]);s.brightness!==void 0&&g.multiplyScalar(s.brightness);const m=a.diffuse[3],y=s.blend==="blend",v={transparent:!0,opacity:m,alphaTest:s.alphaTest??.02,depthWrite:!y};if(s.unlit){const P=new Pg({map:d??void 0,color:g,side:f,toneMapped:!1,...v});return P.name=a.name,P}const S=new mx({map:d??void 0,color:g,side:f,gradientMap:Qs({softness:s.shadingSoftness??sn.shadingSoftness,shadowStrength:s.shadowStrength??sn.shadowStrength}),...v});S.name=a.name,IS(a.toonUrl,{softness:s.shadingSoftness??sn.shadingSoftness,shadowStrength:s.shadowStrength??sn.shadowStrength,terminator:i==="skin"||i==="face"?10:6}).then(P=>{var tt;(tt=S.gradientMap)==null||tt.dispose(),S.gradientMap=P,S.needsUpdate=!0});const T=a.sphereUrl&&a.sphereMode>0?Sp(o.load(a.sphereUrl),r):null,A=(s.anisotropicStrength??0)>0,N=(s.subsurfaceStrength??0)>0,D=s.lightingRig==="face",_=(s.eyeReflectionStrength??0)>0,Y=T?a.sphereMode:0,X={...re,uReflectionStrength:{value:1},uRimStrength:{value:s.rimStrength??sn.rimStrength},uRimPower:{value:s.rimPower??sn.rimPower},uRimColor:{value:new de(s.rimColor??sn.rimColor)},uSpecularStrength:{value:s.specularStrength??sn.specularStrength},uSpecularPower:{value:s.specularPower??sn.specularPower},uEyeReflectionStrength:{value:s.eyeReflectionStrength??0},uEmissiveStrength:{value:s.emissiveStrength??sn.emissiveStrength},uAnisotropicStrength:{value:s.anisotropicStrength??0},uAnisotropicShift:{value:s.anisotropicShift??0},uSubsurfaceStrength:{value:s.subsurfaceStrength??0},uSubsurfaceColor:{value:new de(s.subsurfaceColor??16748395)},uSphereMap:{value:T},uSphereStrength:{value:s.sphereStrength??.45},uAoStrength:{value:s.aoStrength??.55},uSaturation:{value:s.saturation??1},uLocalContrast:{value:s.localContrast??.22},uShadowTint:{value:Do(s.shadowTint??12165798)},uLightTint:{value:Do(s.lightTint??16777215)},uKeyTint:{value:s.keyTint??.18},uFillTint:{value:s.fillTint??.35},uAmbientTint:{value:s.ambientTint??.25},uRimTint:{value:s.rimTint??.3},uHairTint:{value:s.hairTint??.3},uSpecWhiteness:{value:s.specularWhiteness??.4},uRimWhiteness:{value:s.rimWhiteness??.3},uShadowReceive:{value:s.shadowReceive??1},uBounceLevel:{value:s.bounceStrength??.1},uBounceColor:{value:Do(s.bounceColor??16767419)},uBounceTint:{value:s.bounceTint??.4},uMinLight:{value:s.minLight??0},uWarmColor:{value:Do(s.warmColor??16766128)},uWarmth:{value:s.warmth??0},uFrontFillTint:{value:s.frontFillTint??.25},uViewFillStrength:{value:s.viewFillStrength??1},uViewTopStrength:{value:s.viewTopStrength??0},uViewKeyStrength:{value:s.viewKeyStrength??(D?0:.82)},uShadowMid:{value:s.shadowMid??.5},uShadowSoft:{value:s.shadingSoftness??sn.shadingSoftness},uShadowDepth:{value:s.shadowStrength??sn.shadowStrength},uSecondShadow:{value:s.secondShadow??.35}};return S.onBeforeCompile=P=>{Object.assign(P.uniforms,X),P.vertexShader=P.vertexShader.replace("#include <common>",`#include <common>
attribute float aoValue;
varying float vBakedAo;`).replace("#include <begin_vertex>",`#include <begin_vertex>
vBakedAo = aoValue;`),P.fragmentShader=P.fragmentShader.replace("#include <common>",`
        #include <common>
        uniform vec3 uKeyDirView;
        uniform vec3 uKeyColor;
        uniform vec3 uFillDirView;
        uniform vec3 uFillColor;
        uniform vec3 uRimDirView;
        uniform vec3 uRimLightColor;
        uniform vec3 uHairDirView;
        uniform vec3 uHairLightColor;
        uniform vec3 uAmbientSky;
        uniform vec3 uAmbientGround;
        uniform vec3 uUpView;
        uniform float uFillLevel;
        uniform float uAmbientLevel;
        uniform float uRimLevel;
        uniform float uHairLevel;
        uniform float uKeyTint;
        uniform float uFillTint;
        uniform float uAmbientTint;
        uniform float uRimTint;
        uniform float uHairTint;
        uniform float uSpecWhiteness;
        uniform float uRimWhiteness;
        uniform float uShadowReceive;
        uniform float uBounceLevel;
        uniform vec3 uBounceColor;
        uniform float uBounceTint;
        uniform float uMinLight;
        uniform vec3 uWarmColor;
        uniform float uWarmth;
        uniform float uFrontFillLevel;
        uniform vec3 uFrontFillColor;
        uniform float uFrontFillTint;
        uniform float uViewFillStrength;
        uniform float uViewTopStrength;
        uniform float uViewKeyStrength;
        #ifdef USE_FACE_RIG
          uniform vec3 uFaceKeyDirView;
          uniform vec3 uFaceKeyColor;
          uniform vec3 uFaceTopDirView;
          uniform vec3 uFaceTopColor;
          uniform vec3 uFaceRimDirView;
          uniform vec3 uFaceRimColor;
          uniform vec3 uFaceBounceColor;
          uniform vec3 uFaceFillColor;
          uniform float uFaceKeyLevel;
          uniform float uFaceFillLevel;
          uniform float uFaceTopLevel;
          uniform float uFaceRimLevel;
          uniform float uFaceBounceLevel;
        #endif
        uniform vec3 uShadowTint;
        uniform vec3 uLightTint;
        uniform float uShadowMid;
        uniform float uShadowSoft;
        uniform float uShadowDepth;
        uniform float uSecondShadow;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform vec3 uRimColor;
        uniform float uSpecularStrength;
        uniform float uSpecularPower;
        uniform float uEyeReflectionStrength;
        uniform float uEmissiveStrength;
        uniform float uAnisotropicStrength;
        uniform float uAnisotropicShift;
        uniform float uSubsurfaceStrength;
        uniform vec3 uSubsurfaceColor;
        uniform float uAoStrength;
        uniform float uSaturation;
        uniform float uLocalContrast;
        uniform float uReflectionStrength;
        varying float vBakedAo;
        #if SPHERE_MODE > 0
          uniform sampler2D uSphereMap;
          uniform float uSphereStrength;
        #endif
        `).replace("#include <opaque_fragment>",`
        {
          vec3 V = normalize( vViewPosition );
          float NdotV = clamp( dot( normal, V ), 0.0, 1.0 );

          // The face runs on its own portrait rig, anchored to the camera.
          // Everything downstream - terminator, specular, subsurface - is
          // driven from this one direction, so the face is shaped by its own
          // key rather than by the body's world-space light.
          #ifdef USE_FACE_RIG
            vec3 keyDir = uFaceKeyDirView;
            vec3 keyHue = uFaceKeyColor;
          #else
            vec3 keyDir = uKeyDirView;
            vec3 keyHue = uKeyColor;
          #endif

          vec3 H = normalize( keyDir + V );
          float NdotH = clamp( dot( normal, H ), 0.0, 1.0 );

          // ---- two-tone anime shading -------------------------------------
          //
          // This REPLACES three's toon accumulation rather than adding to it.
          // A grayscale ramp multiplied over albedo - which is what the toon
          // material does - is exactly what makes a model read as a flat PMX
          // import: the shadow is just a darker copy of the lit colour.
          //
          // Real anime shading shifts HUE into shadow. Skin shadow goes warm
          // and rosy, hair shadow goes deeper and more saturated. So the lit
          // and shadow sides are computed as separately tinted copies of the
          // albedo and cross-faded across a controlled terminator.
          vec3 albedo = diffuseColor.rgb;

          // Half-lambert keeps the unlit hemisphere readable instead of black.
          float NdotL = dot( normal, keyDir );
          float halfLambert = NdotL * 0.5 + 0.5;

          // Baked contact occlusion, and the cast shadow from the key light.
          //
          // MeshToonMaterial does not expose getShadowMask(), so the key
          // light's shadow map is sampled directly. The key is the rig's only
          // caster, so it is always directional shadow 0.
          float ao = mix( 1.0, clamp( vBakedAo, 0.0, 1.0 ), uAoStrength );
          float shadowMask = 1.0;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
          {
            DirectionalLightShadow keyShadow = directionalLightShadows[ 0 ];
            shadowMask = getShadow(
              directionalShadowMap[ 0 ],
              keyShadow.shadowMapSize,
              keyShadow.shadowIntensity,
              keyShadow.shadowBias,
              keyShadow.shadowRadius,
              vDirectionalShadowCoord[ 0 ]
            );
          }
          #endif

          // Per-material shadow receive.
          //
          // The single most important control for face priority, and what
          // every anime game renderer does: the face does NOT take full cast
          // shadow. Bangs geometrically cover the eyes, so at full strength
          // they drop a hard mask over the most important part of the
          // character. Attenuating the shadow ON THE FACE ONLY keeps hair
          // casting properly onto the body while the face stays readable -
          // without touching the hairstyle or the mesh.
          shadowMask = mix( 1.0, shadowMask, uShadowReceive );

          // Primary terminator - the anime "line of light".
          //
          // Sampled from the model's OWN authored toon ramp (skin.bmp,
          // hair.bmp, toon_defo.bmp) where one exists, so the artist's
          // intended shading break is what drives the shading. Only when a
          // material ships no ramp do we synthesise one.
          float lightFactor;
          #ifdef USE_GRADIENTMAP
            float rampU = clamp(
              ( halfLambert - uShadowMid ) / max( uShadowSoft, 0.001 ) * 0.5 + 0.5,
              0.0, 1.0
            );
            lightFactor = texture2D( gradientMap, vec2( rampU, 0.5 ) ).r;
          #else
            lightFactor = smoothstep(
              uShadowMid - uShadowSoft * 0.5,
              uShadowMid + uShadowSoft * 0.5,
              halfLambert
            );
          #endif
          // Cast shadows and occlusion push a surface into the shadow tone.
          lightFactor *= shadowMask;
          lightFactor *= mix( 1.0, ao, 0.75 );

          // CAMERA-FACING BEAUTY KEY.
          //
          // This is different from adding fill after the fact. Fill can make a
          // dark shadow brighter, but it is still the shadow TONE. A frontal
          // anime hair light must move the visible bangs onto their authored
          // lit tone. It is slightly above and camera-left so the strands keep
          // a soft directional gradient rather than becoming a flat helmet.
          vec3 viewKeyDir = normalize( vec3( -0.16, 0.24, 0.96 ) );
          float viewHalfLambert = dot( normal, viewKeyDir ) * 0.5 + 0.5;
          float viewKeyFactor = smoothstep(
            uShadowMid - uShadowSoft * 0.55,
            uShadowMid + uShadowSoft * 0.55,
            viewHalfLambert
          );
          // A large frontal softbox wraps across every surface visible to the
          // camera. This prevents sideways-authored MMD normals from leaving
          // an entire bang, sleeve or torso panel in the world key's shadow.
          float viewWrap = 0.84 + 0.16 * pow( NdotV, 0.45 );
          viewKeyFactor = max( viewKeyFactor, viewWrap );
          // AO still separates layered strands, but the world key's shadow
          // cannot force the entire camera-facing fringe into darkness.
          viewKeyFactor *= mix( 1.0, ao, 0.22 );
          lightFactor = max(
            lightFactor,
            viewKeyFactor * uViewKeyStrength
          );

          // ---- illumination LEVEL (scalar) --------------------------------
          //
          // Brightness is computed entirely in scalars, and normalised so a
          // fully-lit surface receives exactly 1.0. That is the guarantee that
          // the texture is reproduced faithfully: never darkened, never
          // clipped, and - because no colour is involved here - never tinted.
          //
          // Keeping level and hue separate is the fix for the previous bug,
          // where each light's colour multiplied the texture directly. The key
          // light's linear colour was (1.00, 0.87, 0.72), so every lit pixel
          // lost 28% of its blue and the whole render skewed orange. Exposure
          // could not correct that; it scaled all three channels equally.
          float fillFactor = clamp( dot( normal, uFillDirView ) * 0.5 + 0.5, 0.0, 1.0 );
          float up = dot( normal, uUpView ) * 0.5 + 0.5;
          float rimFacing = clamp( dot( normal, uRimDirView ), 0.0, 1.0 );
          float hairFacing = clamp( dot( normal, uHairDirView ), 0.0, 1.0 );

          // Direct light from the key. Ambient occlusion must NOT attenuate
          // this: AO models self-occlusion of INDIRECT light. A direct light
          // is either blocked or it is not, and that is the shadow map's job,
          // which is already folded into lightFactor. Multiplying direct light
          // by AO darkened the entire character by roughly a fifth uniformly -
          // it was the main reason the render sat below its own texture.
          // A small amount is retained purely for contact darkening.
          float direct = lightFactor * mix( 1.0, ao, 0.25 );

          // Bounce light: soft indirect rising from below, as light reflecting
          // off the chest and floor would. Gated on downward-facing normals so
          // it lands exactly where a real bounce lands - under the chin, along
          // the jawline, the underside of the cheeks and the neck - lifting
          // those out of darkness without erasing the shadow shape above them.
          float bounceFacing = clamp( -dot( normal, uUpView ), 0.0, 1.0 );

          // CAMERA-RELATIVE FRONT FILL.
          //
          // A light that always points along the view direction, so whatever
          // the viewer can see is never in darkness. In view space the vector
          // toward the camera is simply +Z, so a surface's facing ratio is its
          // own view-space normal.z - no uniform direction needed, and it
          // re-aims itself for free as the camera orbits.
          //
          // Because it is perfectly co-axial with the eye it produces no
          // visible terminator, no cast shadow and no directional falloff, so
          // it is never perceived AS a light. It only removes front darkness.
          // NdotV is more reliable than normal.z on MMD faces. Their layered,
          // double-sided cards do not all share the same winding, while NdotV
          // always describes the surface actually visible to the camera.
          float frontFacing = clamp( NdotV, 0.0, 1.0 );
          // A large portrait softbox wraps rather than switching off at the
          // edge. Keep a small directional variation so the fill opens the
          // shadows without turning the face into a flat disc.
          frontFacing = 0.42 + 0.58 * pow( frontFacing, 0.45 );
          vec3 viewTopDir = normalize( vec3( 0.0, 0.82, 0.57 ) );
          float viewTopFacing = smoothstep(
            -0.12, 0.82, dot( normal, viewTopDir )
          );

          #ifdef USE_FACE_RIG
            // ---- portrait indirect, all camera-relative --------------------
            //
            // A photographer lighting a face does not rely on whatever the
            // room bounces back; they place a fill, a hair light and a
            // reflector under the chin. This does the same, in view space, so
            // the setup holds from any viewing angle:
            //
            //   fill   - broad camera-axis source, guarantees eyes, cheeks and
            //            forehead stay readable THROUGH the bangs' shadow
            //   top    - subtle overhead sheen on forehead and cheekbones
            //   rim    - gentle edge separating cheek and jaw from background
            //   bounce - reflector under the chin, lifting jaw and throat
            //
            // The hair shadow is deliberately still there; the fill simply
            // sits above the level at which it would swallow the face.
            float faceTopFacing = smoothstep(
              -0.18, 0.78, dot( normal, uFaceTopDirView )
            );
            float faceRimFacing = pow(
              clamp( dot( normal, uFaceRimDirView ) * 0.5 + 0.5, 0.0, 1.0 ),
              2.2
            ) * pow( 1.0 - NdotV, 1.35 );
            // The fill is deliberately strongest where the key's shadow map
            // says the bangs are blocking the face. It does not erase that
            // shadow: lightFactor still controls the anime shadow tone and
            // the face key. It merely keeps the shadow from swallowing the
            // forehead, eyes and cheeks.
            float shadowFill = mix( 1.0, 1.28, 1.0 - shadowMask );
            float indirect = uFaceFillLevel * frontFacing * shadowFill
              + uFaceTopLevel * faceTopFacing
              + uFaceRimLevel * faceRimFacing
              + uFaceBounceLevel * pow( bounceFacing, 0.65 )
              + uAmbientLevel * 0.38;
            // The face takes only light occlusion: creases should read as
            // softness, never as dirt.
            indirect *= mix( 1.0, ao, 0.28 );
          #else
            // Indirect light - fill, ambient, bounce and the wrap-around back
            // lights. This is what AO legitimately occludes.
            float indirect = uFillLevel * fillFactor * ( 1.0 - lightFactor )
              + uAmbientLevel
              + uBounceLevel * bounceFacing
              + uRimLevel * rimFacing
              + uHairLevel * hairFacing;
            indirect *= ao;
          #endif
          #ifdef USE_FACE_RIG
            // Face levels are authored as a self-contained studio exposure.
            // Do not add the body's front fill here: the dedicated camera
            // softbox above replaces it and keeps body lighting independent.
            float level = direct * uFaceKeyLevel + indirect;
            // The old implementation floored INDIRECT and then divided it,
            // so a requested 0.70 floor could become less than 0.60 on screen.
            // Floor the final face exposure instead. A soft ceiling protects
            // the original texture colours from clipping.
            level = clamp( level, uMinLight, 1.04 );
          #else
            // The body keeps its existing invisible front fill and its exact
            // normalization; none of the portrait changes alter body light.
            float beautyFill = frontFacing * uViewFillStrength
              + viewTopFacing * uViewTopStrength;
            indirect += uFrontFillLevel * beautyFill * mix( 1.0, ao, 0.28 );
            indirect = max( indirect, uMinLight );
            // Key + ambient is full body illumination by definition.
            float level = ( direct + indirect ) / ( 1.0 + uAmbientLevel );
          #endif

          // ---- illumination HUE -------------------------------------------
          //
          // Shadow is a hue shift of the texture, with a deeper core band so
          // the shading has three tones rather than a flat two-step. The lit
          // side stays neutral so the texture reads as authored.
          float coreFactor = smoothstep( 0.0, uShadowMid, halfLambert * shadowMask );
          vec3 shadeTint = uShadowTint * mix( 1.0 - uSecondShadow, 1.0, coreFactor );
          vec3 tint = mix( mix( vec3( 1.0 ), shadeTint, uShadowDepth ), uLightTint, lightFactor );

          // Rig colour enters ONLY as a gentle tint, never a full multiply, so
          // a warm key warms the image without draining its blues.
          tint *= mix( vec3( 1.0 ), keyHue, uKeyTint * lightFactor );
          #ifdef USE_FACE_RIG
            tint *= mix( vec3( 1.0 ), uFaceFillColor, uFillTint * frontFacing );
            tint *= mix( vec3( 1.0 ), uFaceTopColor, uHairTint * faceTopFacing );
            tint *= mix( vec3( 1.0 ), uFaceRimColor, uRimTint * faceRimFacing );
            tint *= mix( vec3( 1.0 ), uFaceBounceColor, uBounceTint * bounceFacing );
          #else
            tint *= mix( vec3( 1.0 ), uFillColor, uFillTint * ( 1.0 - lightFactor ) * fillFactor );
            tint *= mix( vec3( 1.0 ), mix( uAmbientGround, uAmbientSky, up ), uAmbientTint );
            tint *= mix( vec3( 1.0 ), uRimLightColor, uRimTint * rimFacing );
            tint *= mix( vec3( 1.0 ), uHairLightColor, uHairTint * hairFacing );
            tint *= mix( vec3( 1.0 ), uBounceColor, uBounceTint * bounceFacing );
          #endif
          // Warm bounce colour where the bounce actually lands.
          tint *= mix( vec3( 1.0 ), uFrontFillColor, uFrontFillTint * frontFacing );

          // Material warmth. A gentle push toward a warm hue that lifts skin
          // out of grey WITHOUT desaturating it or lightening it - the texture
          // keeps its own colour, it is simply lit by warmer light.
          tint *= mix( vec3( 1.0 ), uWarmColor, uWarmth );

          // Texture colour scaled by a neutral level and shaped by tint.
          outgoingLight = albedo * tint * level;

          #if SPHERE_MODE == 1
            // sph: multiplicative environment tint.
            vec2 sphereUv = normal.xy * 0.5 + 0.5;
            outgoingLight *= texture2D( uSphereMap, sphereUv ).rgb;
          #elif SPHERE_MODE == 2
            // spa: additive environment highlight, tinted by the texture.
            //
            // MMD sphere maps are authored bright, and this model applies them
            // to the trousers and corset - the darkest materials on her. Added
            // raw, the sphere map alone was most of those pixels' value, which
            // lifted near-black cloth to mid-grey. Tinting keeps the highlight
            // on the surface's own colour.
            vec2 sphereUv = normal.xy * 0.5 + 0.5;
            outgoingLight += texture2D( uSphereMap, sphereUv ).rgb
              * uSphereStrength * uReflectionStrength
              * mix( albedo, vec3( 1.0 ), 0.3 );
          #endif

          // Every additive highlight below is TINTED BY THE TEXTURE.
          //
          // This is what keeps dark materials dark. An albedo-independent
          // additive term is a constant floor: on near-black cloth (albedo
          // ~0.05) a rim of 0.26 IS the entire output, so blacks were being
          // lifted about 5x while lit surfaces stayed put, and the whole image
          // collapsed toward mid-grey. Tinting by albedo means a highlight
          // brightens a surface without ever inventing colour it does not have.
          //
          // A small white component is retained so genuine speculars still read
          // as light reflecting off the surface rather than as pure body colour.
          vec3 specTint = mix( albedo, vec3( 1.0 ), uSpecWhiteness );
          vec3 rimTintCol = mix( albedo, vec3( 1.0 ), uRimWhiteness );

          // Art-directed specular from the key light only, gated by the same
          // light factor as the shading so a highlight can never appear on a
          // surface that is in shadow.
          float shadeMask = lightFactor;
          float spec = pow( NdotH, uSpecularPower ) * uSpecularStrength * shadeMask;
          outgoingLight += spec * keyHue * specTint * uReflectionStrength;

          #ifdef USE_EYE_REFLECTIONS
            // Two portrait-softbox reflections make the cornea read as curved
            // and wet. They are camera-relative and intentionally independent
            // of the cast-shadow mask: real reflections remain visible while
            // the bangs shade the iris underneath them.
            vec3 eyeKey = normalize( vec3( -0.24, 0.28, 0.93 ) );
            vec3 eyeFill = normalize( vec3( 0.32, 0.12, 0.94 ) );
            vec3 eyeKeyH = normalize( eyeKey + V );
            vec3 eyeFillH = normalize( eyeFill + V );
            float eyeGlint = pow(
              clamp( dot( normal, eyeKeyH ), 0.0, 1.0 ), 110.0
            );
            float eyeSoftbox = pow(
              clamp( dot( normal, eyeFillH ), 0.0, 1.0 ), 38.0
            ) * 0.32;
            outgoingLight += ( eyeGlint + eyeSoftbox )
              * uEyeReflectionStrength
              * mix( albedo, vec3( 1.0 ), 0.94 );
          #endif

          #ifdef USE_ANISOTROPIC
            // Kajiya-Kay banded highlight. The strand tangent is approximated
            // by world-up projected onto the surface, which produces the
            // horizontal highlight band that reads as anime hair.
            vec3 strand = uUpView - normal * dot( normal, uUpView );
            if ( length( strand ) > 1e-4 ) {
              strand = normalize( strand );
              vec3 shifted = normalize( strand + normal * uAnisotropicShift );
              float ToH = dot( shifted, H );
              float sinTH = sqrt( max( 0.0, 1.0 - ToH * ToH ) );
              outgoingLight += pow( sinTH, 48.0 ) * uAnisotropicStrength
                * shadeMask * keyHue * specTint * uReflectionStrength;
              // A second, camera-relative studio reflection keeps the hair's
              // highlight readable from front, back and arbitrary orbit views.
              vec3 beautyH = normalize(
                normalize( vec3( -0.22, 0.38, 0.90 ) ) + V
              );
              float beautyToH = dot( shifted, beautyH );
              float beautySinTH = sqrt(
                max( 0.0, 1.0 - beautyToH * beautyToH )
              );
              outgoingLight += pow( beautySinTH, 52.0 )
                * uAnisotropicStrength * 0.42
                * uViewFillStrength * uFrontFillLevel
                * uFrontFillColor * specTint * uReflectionStrength;
            }
          #endif

          // Fresnel rim, weighted toward the back light so it separates the
          // silhouette from the stage instead of glowing uniformly.
          float rim = pow( 1.0 - NdotV, uRimPower ) * uRimStrength;
          rim *= 0.5 + 0.5 * clamp( dot( normal, uRimDirView ) * 0.5 + 0.5, 0.0, 1.0 );
          outgoingLight += rim * uRimColor * rimTintCol * uReflectionStrength;

          #ifdef USE_SUBSURFACE
            // Warm bleed through the shadow terminator. On skin this is the
            // rosy band right at the light/shadow boundary that separates a
            // rendered face from a plastic one.
            float sss = smoothstep( 0.3, -0.2, NdotL ) * smoothstep( -0.65, -0.05, NdotL );
            outgoingLight += sss * uSubsurfaceStrength * uSubsurfaceColor * albedo * ao;
          #endif

          outgoingLight += albedo * uEmissiveStrength;

          // Local contrast, NOT global brightness.
          //
          // An S-curve about mid-grey pushes darks down and lights up while
          // leaving the midpoint fixed, so the image gains depth without the
          // overall exposure moving. This is what separates surfaces from each
          // other; raising brightness only flattens them together.
          vec3 clamped = clamp( outgoingLight, 0.0, 1.0 );
          vec3 sCurve = clamped * clamped * ( 3.0 - 2.0 * clamped );
          outgoingLight = mix( outgoingLight, sCurve, uLocalContrast );

          // Saturation is a trim, defaulting to 1.0 (untouched). The texture's
          // own colour is the reference and must not be repainted.
          float lum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
          outgoingLight = mix( vec3( lum ), outgoingLight, uSaturation );
        }
        #include <opaque_fragment>
        `),P.defines={...P.defines??{},SPHERE_MODE:Y,...A?{USE_ANISOTROPIC:""}:{},...N?{USE_SUBSURFACE:""}:{},...D?{USE_FACE_RIG:""}:{},..._?{USE_EYE_REFLECTIONS:""}:{}}},S.customProgramCacheKey=()=>`anime|${Y}|${A?1:0}|${N?1:0}|${D?1:0}|${_?1:0}`,S.userData.animeUniforms=X,S}function t2(a,i){const s=a.userData.animeUniforms;s!=null&&s.uReflectionStrength&&(s.uReflectionStrength.value=et.clamp(i,0,2))}function wp(a,i){for(const[s,o]of Object.entries(i))if(o.includes(a))return s;return"cloth"}function e2(a,i,s,o={}){const r=o.scale??1;let h=!1;const f=a.materials.map(g=>{const m=s(i(g.name)),y=(m.outlineWidth??g.edgeSize)*r,v=new de(m.outlineColor??g.edgeColor.getHex()),S=new Pg({color:v,side:yx,toneMapped:!1,fog:!1,polygonOffset:!0,polygonOffsetFactor:2,polygonOffsetUnits:2});S.name=`${g.name}__outline`,y<=0?S.visible=!1:h=!0;const T={value:y};return S.onBeforeCompile=A=>{A.uniforms.uOutlineWidth=T,A.vertexShader=A.vertexShader.replace("#include <common>",`#include <common>
uniform float uOutlineWidth;`).replace("#include <project_vertex>",`
          // Equivalent to <project_vertex>, with the vertex pushed out along
          // its normal in view space before projection.
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_BATCHING
            mvPosition = batchingMatrix * mvPosition;
          #endif
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          mvPosition = modelViewMatrix * mvPosition;

          // -mvPosition.z is the view distance; scaling by it keeps the
          // outline visually constant instead of shrinking with distance.
          mvPosition.xyz += normalize( transformedNormal )
            * max( -mvPosition.z, 0.001 ) * uOutlineWidth * 0.0016;

          gl_Position = projectionMatrix * mvPosition;
          `)},S.defines={...S.defines??{},USE_OUTLINE:""},S});if(!h)return null;const d=new Kg(a.mesh.geometry,f);return d.name=`${a.mesh.name}__outline`,d.frustumCulled=!1,d.castShadow=!1,d.receiveShadow=!1,d.renderOrder=1,d.bind(a.skeleton,a.mesh.bindMatrix),d}function Sn(a,i){const s=et.degToRad(a),o=et.degToRad(i);return new ft(Math.sin(s)*Math.cos(o),Math.sin(o),Math.cos(s)*Math.cos(o)).normalize()}class n2{constructor(i){this.config=i,this.group=new Zg,this.target=new Yg,this.keyDirWorld=new ft,this.rimDirWorld=new ft,this.fillDirWorld=new ft,this.hairDirWorld=new ft,this.scratch=new ft,this.group.name="AnimeLightingRig",this.group.add(this.target),this.key=new Gs(i.keyColor,i.keyIntensity),this.fill=new Gs(i.fillColor,i.fillIntensity),this.rim=new Gs(i.rimColor,i.rimIntensity),this.hair=new Gs(i.hairLightColor,i.hairLightIntensity),this.bounce=new Gs(i.ambientGroundColor,i.environmentIntensity),this.ambient=new vx(i.ambientSkyColor,i.ambientGroundColor,i.ambientIntensity);for(const s of[this.key,this.fill,this.rim,this.hair,this.bounce])s.target=this.target,this.group.add(s);this.group.add(this.ambient),this.key.name="keyLight",this.fill.name="fillLight",this.rim.name="rimLight",this.hair.name="hairLight",this.applyConfig(),this.applyFaceRig()}applyConfig(){const i=this.config,s=40;this.keyDirWorld.copy(Sn(i.keyAzimuth,i.keyElevation)),this.rimDirWorld.copy(Sn(i.rimAzimuth,i.rimElevation)),this.fillDirWorld.copy(Sn(i.fillAzimuth,i.fillElevation)),this.hairDirWorld.copy(Sn(i.keyAzimuth+180,62)),this.key.position.copy(this.keyDirWorld).multiplyScalar(s),this.fill.position.copy(Sn(i.fillAzimuth,i.fillElevation)).multiplyScalar(s),this.rim.position.copy(this.rimDirWorld).multiplyScalar(s),this.hair.position.copy(Sn(i.keyAzimuth+180,62)).multiplyScalar(s),this.bounce.position.copy(Sn(0,-28)).multiplyScalar(s),this.key.color.set(i.keyColor),this.key.intensity=i.keyIntensity,this.fill.color.set(i.fillColor),this.fill.intensity=i.fillIntensity,this.rim.color.set(i.rimColor),this.rim.intensity=i.rimIntensity,this.hair.color.set(i.hairLightColor),this.hair.intensity=i.hairLightIntensity,this.bounce.color.set(i.ambientGroundColor),this.bounce.intensity=i.environmentIntensity,this.ambient.color.set(i.ambientSkyColor),this.ambient.groundColor.set(i.ambientGroundColor),this.ambient.intensity=i.ambientIntensity,this.key.castShadow=i.shadow.enabled;const o=this.key.shadow;o.mapSize.setScalar(i.shadow.mapSize),o.radius=i.shadow.radius,o.bias=i.shadow.bias,o.normalBias=i.shadow.normalBias,o.intensity=i.shadow.opacity,o.blurSamples=16}frame(i,s){this.target.position.copy(i),this.group.position.set(0,0,0);const o=this.key.shadow.camera,r=s*1.15;o.left=-r,o.right=r,o.top=r,o.bottom=-r,o.near=1,o.far=120,o.updateProjectionMatrix();const h=40;this.key.position.copy(i).addScaledVector(this.keyDirWorld,h),this.fill.position.copy(i).addScaledVector(Sn(this.config.fillAzimuth,this.config.fillElevation),h),this.rim.position.copy(i).addScaledVector(this.rimDirWorld,h),this.hair.position.copy(i).addScaledVector(Sn(this.config.keyAzimuth+180,62),h),this.bounce.position.copy(i).addScaledVector(Sn(0,-28),h)}update(i){const s=(r,h)=>r.copy(h).transformDirection(i.matrixWorldInverse).normalize();s(re.uKeyDirView.value,this.keyDirWorld),s(re.uRimDirView.value,this.rimDirWorld),s(re.uFillDirView.value,this.fillDirWorld),s(re.uHairDirView.value,this.hairDirWorld),s(re.uUpView.value,this.scratch.set(0,1,0)),re.uKeyColor.value.copy(this.key.color),re.uFillColor.value.copy(this.fill.color),re.uRimLightColor.value.copy(this.rim.color),re.uHairLightColor.value.copy(this.hair.color),re.uAmbientSky.value.copy(this.ambient.color),re.uAmbientGround.value.copy(this.ambient.groundColor);const o=Math.max(this.key.intensity,.001);re.uFillLevel.value=this.fill.intensity/o,re.uAmbientLevel.value=this.ambient.intensity/o,re.uRimLevel.value=this.rim.intensity/o,re.uHairLevel.value=this.hair.intensity/o,re.uFrontFillLevel.value=this.config.frontFillIntensity/o,re.uFrontFillColor.value.set(this.config.frontFillColor)}applyFaceRig(){const i=this.config.face,s=re,o=et.degToRad(i.keyAzimuth),r=et.degToRad(i.keyElevation);s.uFaceKeyDirView.value.set(-Math.sin(o)*Math.cos(r),Math.sin(r),Math.cos(o)*Math.cos(r)).normalize(),s.uFaceTopDirView.value.set(0,.94,.34).normalize(),s.uFaceRimDirView.value.set(.52,.36,-.78).normalize(),s.uFaceKeyColor.value.set(i.keyColor),s.uFaceFillColor.value.set(i.fillColor),s.uFaceTopColor.value.set(i.topColor),s.uFaceRimColor.value.set(i.rimColor),s.uFaceBounceColor.value.set(i.bounceColor),s.uFaceKeyLevel.value=i.keyIntensity,s.uFaceFillLevel.value=i.fillIntensity,s.uFaceTopLevel.value=i.topIntensity,s.uFaceRimLevel.value=i.rimIntensity,s.uFaceBounceLevel.value=i.bounceIntensity}setConfig(i){this.config=i,this.applyConfig(),this.applyFaceRig()}dispose(){var i;(i=this.key.shadow.map)==null||i.dispose(),this.group.removeFromParent()}}const i2={none:Ax,neutral:Wg,aces:Tx,reinhard:wx,cineon:Sx};class a2{constructor(i,s,o){this.canvas=i,this.renderConfig=s,this.scene=new bx,this.focus=new ft,this.pointer=new nl,this.pointerTarget=new nl,this.orbitYaw=0,this.orbitPitch=0,this.targetYaw=0,this.targetPitch=0,this.orbitDistance=0,this.targetDistance=0,this.locked=!1,this.width=1,this.height=1,this.disposed=!1,this.framing=o,this.orbitDistance=o.distance,this.targetDistance=o.distance,this.renderer=new xx({canvas:i,alpha:!0,antialias:s.antialias,powerPreference:"high-performance",logarithmicDepthBuffer:!1,stencil:!1}),this.renderer.setClearColor(0,0),this.renderer.outputColorSpace=Qg,this.renderer.toneMapping=i2[s.toneMapping]??Wg,this.renderer.toneMappingExposure=s.exposure,this.renderer.shadowMap.enabled=!0,this.renderer.shadowMap.type=Mx,this.camera=new Ex(o.fov,1,.1,500),this.camera.position.set(0,0,o.distance),this.scene.add(this.camera)}get maxAnisotropy(){return this.renderer.capabilities.getMaxAnisotropy()}setFocus(i){this.focus.copy(i)}setPointer(i,s){this.pointerTarget.set(et.clamp(i,-1,1),et.clamp(s,-1,1))}setFraming(i){this.framing=i,this.camera.fov=i.fov,this.camera.updateProjectionMatrix()}orbitBy(i,s){this.locked||(this.targetYaw+=i,this.targetPitch=et.clamp(this.targetPitch+s,-Math.PI/3,Math.PI/3))}setOrbit(i,s=this.targetPitch){this.locked||(this.targetYaw=i,this.targetPitch=et.clamp(s,-Math.PI/3,Math.PI/3))}zoomBy(i){this.locked||(this.targetDistance=et.clamp(this.targetDistance+i,this.framing.minDistance,this.framing.maxDistance))}setLocked(i){this.locked=i}get isLocked(){return this.locked}get orbit(){return{yaw:this.targetYaw,pitch:this.targetPitch,distance:this.targetDistance}}resetView(){this.locked||(this.targetYaw=0,this.targetPitch=0,this.targetDistance=this.framing.distance)}resize(i,s){if(i<=0||s<=0)return;this.width=i,this.height=s;const o=Math.min(window.devicePixelRatio||1,this.renderConfig.maxPixelRatio);this.renderer.setPixelRatio(o),this.renderer.setSize(i,s,!1),this.camera.aspect=i/s,this.camera.updateProjectionMatrix()}update(i){const s=1-Math.exp(-6*i);this.pointer.lerp(this.pointerTarget,s);const o=1-Math.exp(-8*i);this.orbitYaw=et.lerp(this.orbitYaw,this.targetYaw,o),this.orbitPitch=et.lerp(this.orbitPitch,this.targetPitch,o),this.orbitDistance=et.lerp(this.orbitDistance,this.targetDistance,o);const{heightOffset:r,parallax:h}=this.framing,f=this.locked?0:this.pointer.x*h,d=this.locked?0:this.pointer.y*h*.6,g=this.orbitYaw+f,m=this.orbitPitch+d,y=this.orbitDistance;this.camera.position.set(this.focus.x+Math.sin(g)*Math.cos(m)*y,this.focus.y+r+Math.sin(m)*y,this.focus.z+Math.cos(g)*Math.cos(m)*y),this.camera.lookAt(this.focus),this.camera.updateMatrixWorld()}render(){this.disposed||this.renderer.render(this.scene,this.camera)}get isValid(){return!this.disposed&&!this.renderer.getContext().isContextLost()}dispose(){this.disposed||(this.disposed=!0,this.renderer.dispose())}get size(){return{width:this.width,height:this.height}}get element(){return this.canvas}}class s2{constructor(i){this.model=i,this.boneWeights=new Map,this.boneMorphBones=new Set,this._quat=new Ce,this._identity=new Ce,this.vertexWeights=new Float32Array(i.vertexMorphs.size);for(const s of i.boneMorphs.values())for(const o of s.elements){const r=i.bones[o.boneIndex];r&&this.boneMorphBones.add(r)}}has(i){return i?this.model.vertexMorphs.has(i)||this.model.boneMorphs.has(i)||this.model.groupMorphs.has(i):!1}begin(){this.vertexWeights.fill(0),this.boneWeights.clear()}add(i,s){if(!i||s===0)return;const o=this.model.vertexMorphs.get(i);if(o){this.vertexWeights[o.morphTargetIndex]+=s;return}if(this.model.boneMorphs.has(i)){this.boneWeights.set(i,(this.boneWeights.get(i)??0)+s);return}const r=this.model.groupMorphs.get(i);if(r)for(const h of r.elements)this.add(h.morphName,s*h.ratio)}commitVertexMorphs(){const i=this.model.mesh.morphTargetInfluences;if(i)for(let s=0;s<this.vertexWeights.length;s++)i[s]=et.clamp(this.vertexWeights[s],0,1)}commitBoneMorphs(){if(this.boneWeights.size!==0)for(const[i,s]of this.boneWeights){const o=this.model.boneMorphs.get(i);if(!o)continue;const r=et.clamp(s,0,1);if(!(r<=0))for(const h of o.elements){const f=this.model.bones[h.boneIndex];f&&(f.position.addScaledVector(h.position,r),this._quat.copy(this._identity).slerp(h.rotation,r),f.quaternion.multiply(this._quat))}}}get morphedBones(){return this.boneMorphBones}describe(){return{vertex:[...this.model.vertexMorphs.keys()],bone:[...this.model.boneMorphs.keys()],group:[...this.model.groupMorphs.keys()]}}}const Nc=new Set(["visemeA","visemeI","visemeU","visemeE","visemeO","visemeTalk","mouthSmile","mouthCornerUpL","mouthCornerUpR","mouthCornerDownL","mouthCornerDownR","mouthWiden","mouthNarrow","mouthShiftRight","mouthShiftLeft","mouthUp","mouthDown","mouthWidenL","mouthWidenR","mouthNarrowL","mouthNarrowR","teethUp","teethDown"]),Uo={neutral:{lowerLidUp:.07,mouthCornerUpL:.04,mouthCornerUpR:.04,browUp:.025},happy:{smileEyes:.18,lowerLidUp:.4,mouthSmile:.2,mouthCornerUpL:.72,mouthCornerUpR:.72,mouthWiden:.18,browUp:.3},excited:{eyesWideL:.62,eyesWideR:.62,lowerLidUp:.12,mouthSmile:.24,mouthCornerUpL:.8,mouthCornerUpR:.8,mouthWiden:.28,visemeA:.22,browUp:.82},curious:{eyesWideL:.2,eyesWideR:.42,lowerLidUp:.1,browUp:.45,browAngryR:.22,mouthNarrow:.2,mouthShiftLeft:.1,mouthCornerUpR:.08},thinking:{eyesHalf:.34,browTroubled:.62,browSerious:.18,browUp:.08,mouthNarrow:.35,mouthShiftLeft:.16,mouthCornerDownR:.16},proud:{eyesHalf:.26,lowerLidUp:.22,browSerious:.55,browDown:.08,mouthSmile:.3,mouthCornerUpL:.44,mouthCornerUpR:.32,mouthShiftRight:.04},sad:{eyesSad:.75,eyeOuterDown:.18,lowerLidUp:.08,browSad:.88,browTroubled:.2,mouthCornerDownL:.55,mouthCornerDownR:.55,mouthNarrow:.14},confused:{eyesWideL:.3,eyesHalf:.24,browTroubled:.78,browUp:.18,browAngryR:.32,mouthNarrow:.28,mouthShiftRight:.2,mouthCornerDownL:.28,mouthCornerUpR:.06},surprised:{eyesWideL:.92,eyesWideR:.92,browUp:1,visemeO:.55,mouthNarrow:.12},embarrassed:{eyesHalf:.48,eyesSad:.32,eyeOuterDown:.08,lowerLidUp:.3,browTroubled:.7,browSad:.28,browUp:.1,mouthSmile:.04,mouthCornerUpL:.09,mouthCornerDownR:.05,mouthNarrow:.27,mouthShiftLeft:.1},playful:{blinkL:.92,lowerLidUp:.26,mouthSmile:.5,mouthCornerUpL:.68,mouthCornerUpR:.36,mouthShiftRight:.13,browUp:.34,browAngryR:.24},listening:{eyesWideL:.14,eyesWideR:.14,lowerLidUp:.17,browUp:.3,mouthSmile:.05,mouthCornerUpL:.1,mouthCornerUpR:.1}};function l2(a){return a in Uo?a:"neutral"}const Zs=.055,eh=.032,sy=.115,o2=Zs+eh+sy;class r2{constructor(i,s,o){this.morphs=i,this.morphMap=s,this.idleConfig=o,this.currentShape=new Map,this.targetShape=Uo.neutral,this.targetName="neutral",this.expressionTime=0,this.blendDuration=.45,this.blinkTimer=0,this.blinkNext=0,this.blinkPhase=-1,this.pendingDoubleBlink=!1,this.blinkOverride=null,this.scheduleBlink();for(const[r,h]of Object.entries(Uo.neutral))this.currentShape.set(r,h)}setExpression(i,s=.45){const o=l2(i);o!==this.targetName&&(this.targetName=o,this.targetShape=Uo[o],this.expressionTime=0,this.blendDuration=Math.max(.01,s))}get expression(){return this.targetName}triggerBlink(){this.blinkPhase<0&&(this.blinkPhase=0,this.blinkTimer=0)}setBlinkOverride(i){this.blinkOverride=i}scheduleBlink(){const{blinkIntervalMin:i,blinkIntervalMax:s}=this.idleConfig;this.blinkNext=et.randFloat(i,s),this.blinkTimer=0,this.blinkPhase=-1}updateBlink(i){if(this.blinkPhase<0)return this.blinkTimer+=i,this.blinkTimer>=this.blinkNext&&(this.blinkPhase=0,this.blinkTimer=0,this.pendingDoubleBlink=Math.random()<this.idleConfig.doubleBlinkChance),0;this.blinkPhase+=i;const s=this.blinkPhase;return s>=o2?this.pendingDoubleBlink?(this.pendingDoubleBlink=!1,this.blinkPhase=0,0):(this.scheduleBlink(),0):s<Zs?et.smoothstep(s/Zs,0,1):s<Zs+eh?1:1-et.smoothstep((s-Zs-eh)/sy,0,1)}update(i){const{delta:s,visemes:o,speechAuthority:r}=i;this.expressionTime+=s;const h=1-Math.exp(-(s/this.blendDuration)*3),f=new Set([...this.currentShape.keys(),...Object.keys(this.targetShape)]);for(const m of f){const y=this.currentShape.get(m)??0,v=this.targetShape[m]??0,S=et.lerp(y,v,h);S<1e-4&&v===0?this.currentShape.delete(m):this.currentShape.set(m,S)}const d=1-et.clamp(r,0,1);for(const[m,y]of this.currentShape){const v=Nc.has(m)?y*d:y;this.morphs.add(this.morphMap[m],v)}if(this.emitExpressionMotion(d),i.overlay&&(i.overlayWeight??0)>0){const m=i.overlayWeight;for(const[y,v]of Object.entries(i.overlay)){const S=Nc.has(y)?v*d:v;this.morphs.add(this.morphMap[y],S*m)}}const g=this.updateBlink(s);if(this.blinkOverride)this.morphs.add(this.morphMap.blinkL,this.blinkOverride.left),this.morphs.add(this.morphMap.blinkR,this.blinkOverride.right);else if(g>0){const m=this.currentShape.get("smileEyes")??0;this.morphs.add(this.morphMap.blink,g*(1-m*.75))}if(r>0){const m=r;this.morphs.add(this.morphMap.visemeA,o.a*m),this.morphs.add(this.morphMap.visemeI,o.i*m),this.morphs.add(this.morphMap.visemeU,o.u*m),this.morphs.add(this.morphMap.visemeE,o.e*m),this.morphs.add(this.morphMap.visemeO,o.o*m),this.morphs.add(this.morphMap.visemeTalk,o.talk*m),this.morphs.add(this.morphMap.teethUp,o.openness*.35*m)}}emitExpressionMotion(i){const s=.5+.5*Math.sin(this.expressionTime*1.7),o=Math.exp(-this.expressionTime*1.7)*Math.sin(Math.min(1,this.expressionTime/.42)*Math.PI),r=(h,f)=>{const d=Nc.has(h)?f*i:f;this.morphs.add(this.morphMap[h],d)};switch(this.targetName){case"happy":r("browUp",.035*s+.08*o),r("lowerLidUp",.025*s);break;case"excited":r("browUp",.05*s+.12*o),r("eyesWideL",.04*s),r("eyesWideR",.04*s);break;case"curious":r("browAngryR",.07*s+.1*o);break;case"thinking":r("browTroubled",.06*s+.08*o);break;case"proud":r("browSerious",.045*s),r("mouthCornerUpL",.035*s);break;case"sad":r("browSad",.055*s+.1*o);break;case"confused":r("browAngryR",.08*s+.12*o),r("browTroubled",.04*s);break;case"surprised":r("browUp",.06*s+.18*o),r("eyesWideL",.1*o),r("eyesWideR",.1*o);break;case"embarrassed":r("browTroubled",.08*s+.18*o),r("browSad",.05*s),r("eyesHalf",.045*s);break;case"playful":r("browAngryR",.08*s),r("mouthCornerUpL",.05*s);break}}}const ko={low:[180,620],lowMid:[620,1150],mid:[1150,1900],high:[1900,3400]};class u2{constructor(i){this.config=i,this.spectrum=new Uint8Array(0),this.envelope=0,this.speechClock=0,this.current={a:0,i:0,u:0,e:0,o:0,talk:0,openness:0},this.target={a:0,i:0,u:0,e:0,o:0,talk:0,openness:0},this.binRanges=null,this.cachedFftSize=-1,this.cachedSampleRate=-1}setConfig(i){this.config=i}silence(i){return this.update(null,i)}update(i,s,o=i!==null){i&&i.context.state==="running"?this.analyse(i):o?this.synthesiseSpeech(s):(this.target.openness=0,this.target.a=this.target.i=this.target.u=0,this.target.e=this.target.o=this.target.talk=0);const r=1-Math.exp(-(this.config.visemeBlendRate*60)*s);this.current.a=et.lerp(this.current.a,this.target.a,r),this.current.i=et.lerp(this.current.i,this.target.i,r),this.current.u=et.lerp(this.current.u,this.target.u,r),this.current.e=et.lerp(this.current.e,this.target.e,r),this.current.o=et.lerp(this.current.o,this.target.o,r),this.current.talk=et.lerp(this.current.talk,this.target.talk,r);const h=this.target.openness>this.current.openness?this.config.attack:this.config.release,f=1-Math.exp(-(h*60)*s);return this.current.openness=et.lerp(this.current.openness,this.target.openness,f),this.current}synthesiseSpeech(i){this.speechClock+=i;const s=Math.pow(Math.max(0,Math.sin(this.speechClock*Math.PI*2*3.7)),1.45),o=.78+Math.sin(this.speechClock*.82)*.18,r=et.clamp((.12+s*.62)*o,0,.78),h=Math.sin(this.speechClock*2.15+.7)*.5+.5,f=Math.sin(this.speechClock*1.57+2.1)*.5+.5,d=h*(1-f),g=h*f,m=(1-h)*(1-f)*.64,y=(1-h)*(1-f)*.36,v=(1-h)*f,S=d+g+m+y+v||1,T=r*this.config.maxWeight/S;this.target.a=d*T,this.target.e=g*T,this.target.o=m*T,this.target.u=y*T,this.target.i=v*T,this.target.talk=r*.2*this.config.maxWeight,this.target.openness=r}ensureBins(i){const s=i.context.sampleRate;if(this.cachedFftSize===i.fftSize&&this.cachedSampleRate===s)return;this.cachedFftSize=i.fftSize,this.cachedSampleRate=s;const o=i.frequencyBinCount,r=s/2/o,h=([f,d])=>[et.clamp(Math.floor(f/r),0,o-1),et.clamp(Math.ceil(d/r),1,o)];this.binRanges={low:h(ko.low),lowMid:h(ko.lowMid),mid:h(ko.mid),high:h(ko.high)},this.spectrum.length!==o&&(this.spectrum=new Uint8Array(o))}analyse(i){if(this.ensureBins(i),!this.binRanges)return;try{i.getByteFrequencyData(this.spectrum)}catch{return}const s=k=>{let U=0;for(let $=k[0];$<k[1];$++)U+=this.spectrum[$];const W=Math.max(1,k[1]-k[0]);return U/W/255},o=s(this.binRanges.low),r=s(this.binRanges.lowMid),h=s(this.binRanges.mid),f=s(this.binRanges.high),d=o+r+h+f,{noiseFloor:g,gain:m,maxWeight:y}=this.config;if(d<g){this.target.openness=0,this.target.a=this.target.i=this.target.u=0,this.target.e=this.target.o=this.target.talk=0,this.envelope*=.9;return}const v=et.clamp(d/2*m,0,1);this.envelope=Math.pow(v,.7),this.target.openness=et.clamp(this.envelope,0,1);const S=et.clamp(o/(o+r+1e-5),0,1),T=et.clamp((h+f)/(d+1e-5),0,1),A=et.smoothstep(S,.25,.75),N=et.smoothstep(T,.12,.45),D=A*(1-N),_=A*N,Y=(1-A)*(1-N)*.6,X=(1-A)*(1-N)*.4,P=(1-A)*N,tt=D+_+Y+X+P||1,F=this.envelope*y/tt;this.target.a=D*F,this.target.e=_*F,this.target.o=Y*F,this.target.u=X*F,this.target.i=P*F,this.target.talk=this.envelope*.25*y}get weights(){return this.current}}class c2{constructor(i){this.model=i,this.rest=new Map,this.rotations=new Map,this.translations=new Map,this._quat=new Ce,this._euler=new Rh,this._identity=new Ce}register(i){if(!i||this.rest.has(i))return!!i&&this.rest.has(i);const s=this.model.boneIndexByName.get(i);if(s===void 0)return!1;const o=this.model.bones[s];return o?(this.rest.set(i,{bone:o,position:o.position.clone(),quaternion:o.quaternion.clone()}),!0):!1}registerAll(i){for(const s of i)this.register(s)}has(i){return!!i&&this.rest.has(i)}bakeIntoRest(i,s=0,o=0,r=0){if(!i)return;const h=this.rest.get(i);h&&(this._euler.set(s,o,r,"XYZ"),this._quat.setFromEuler(this._euler),h.quaternion.multiply(this._quat),h.bone.quaternion.copy(h.quaternion))}begin(){this.rotations.clear(),this.translations.clear()}addEuler(i,s,o,r,h=1){!i||h===0||!this.rest.has(i)||s===0&&o===0&&r===0||(this._euler.set(s*h,o*h,r*h,"XYZ"),this._quat.setFromEuler(this._euler),this.addQuaternion(i,this._quat))}addQuaternion(i,s,o=1){if(!i||!this.rest.has(i))return;let r=this.rotations.get(i);r||(r=new Ce,this.rotations.set(i,r)),o>=.999?r.multiply(s):(this._quat.copy(this._identity).slerp(s,o),r.multiply(this._quat))}addTranslation(i,s,o,r,h=1){if(!i||h===0||!this.rest.has(i))return;let f=this.translations.get(i);f||(f=new ft,this.translations.set(i,f)),f.x+=s*h,f.y+=o*h,f.z+=r*h}apply(){for(const[i,s]of this.rest){const o=this.rotations.get(i),r=this.translations.get(i);s.bone.quaternion.copy(s.quaternion),o&&s.bone.quaternion.multiply(o),s.bone.position.copy(s.position),r&&s.bone.position.add(r)}}get drivenBones(){return[...this.rest.keys()]}}function Tp(a){const i=Math.sin(a*127.1)*43758.5453123;return(i-Math.floor(i))*2-1}function h2(a){const i=Math.floor(a),s=a-i,o=s*s*(3-2*s);return Tp(i)*(1-o)+Tp(i+1)*o}function xi(a,i=2){let s=0,o=1,r=1,h=0;for(let f=0;f<i;f++)s+=h2(a*r)*o,h+=o,o*=.5,r*=2.07;return h>0?s/h:0}function jc(a){const i=a-Math.floor(a),s=.38;if(i<s){const r=i/s;return r*r*(3-2*r)}const o=(i-s)/(1-s);return 1-(o*o*(3-2*o))**.85}function Wi(a){const i=Math.min(1,Math.max(0,a));return i*i*(3-2*i)}function f2(a){const i=Math.min(1,Math.max(0,a)),s=1.35,o=i-1;return o*o*((s+1)*o+s)+1}const se={breathChest:.0135,breathUpperChest:.009,breathNeckCounter:.0055,breathShoulder:.011,breathRise:.035,swayHipRoll:.019,swayHipYaw:.011,swayLateral:.09,swayChestCounter:.012,postureHipRoll:.028,postureChestRoll:.017,postureHeadRoll:.021,postureLateral:.11,microHead:.016,microShoulder:.008};class d2{constructor(i,s){this.bones=i,this.config=s,this.time=0,this.breathPhase=0,this.postureTimer=0,this.postureNext=0,this.posture={weight:0,roll:0,yaw:0,lateral:0,elapsed:0,duration:4,active:!1},this.intensity=1,this.intensityTarget=1,this.scheduleposture()}setConfig(i){this.config=i}setIntensity(i){this.intensityTarget=et.clamp(i,0,1)}get breath(){return jc(this.breathPhase)}scheduleposture(){this.postureTimer=0,this.postureNext=et.randFloat(this.config.postureIntervalMin,this.config.postureIntervalMax)}updatePosture(i){if(!this.posture.active){if(this.postureTimer+=i,this.postureTimer>=this.postureNext){this.posture.active=!0,this.posture.elapsed=0,this.posture.duration=et.randFloat(3.5,8);const o=Math.random()<.5?-1:1;this.posture.roll=o*et.randFloat(.5,1),this.posture.yaw=o*et.randFloat(.2,.8),this.posture.lateral=o*et.randFloat(.4,1)}return}this.posture.elapsed+=i;const s=this.posture.elapsed/this.posture.duration;if(s>=1){this.posture.active=!1,this.posture.weight=0,this.scheduleposture();return}s<.33?this.posture.weight=Wi(s/.33):s>.67?this.posture.weight=Wi((1-s)/.33):this.posture.weight=1}update(i,s){this.time+=i,this.intensity=et.lerp(this.intensity,this.intensityTarget,1-Math.exp(-4*i));const o=this.intensity,r=this.config.breathDepth*o,h=this.config.swayAmount*o;this.breathPhase+=i*this.config.breathRate;const d=jc(this.breathPhase)-.5;s.addEuler(this.bones.upperBody,-d*se.breathChest*r,0,0),s.addEuler(this.bones.upperBody2,d*se.breathUpperChest*r,0,0),s.addEuler(this.bones.neck,-d*se.breathNeckCounter*r,0,0),s.addTranslation(this.bones.center,0,d*se.breathRise*r,0);const g=jc(this.breathPhase-.08)-.5;s.addEuler(this.bones.shoulderL,0,0,-g*se.breathShoulder*r),s.addEuler(this.bones.shoulderR,0,0,g*se.breathShoulder*r);const m=this.time*this.config.swayRate,y=Math.sin(m*Math.PI*2)*.6+xi(m*1.7)*.4,v=xi(m*.6+31.7);if(s.addTranslation(this.bones.center,y*se.swayLateral*h,0,0),s.addEuler(this.bones.waist,0,v*se.swayHipYaw*h,y*se.swayHipRoll*h),s.addEuler(this.bones.upperBody,0,0,-y*se.swayChestCounter*h),this.updatePosture(i),this.posture.weight>0){const S=this.posture.weight*o;s.addTranslation(this.bones.center,this.posture.lateral*se.postureLateral*S,0,0),s.addEuler(this.bones.waist,0,this.posture.yaw*se.postureHipRoll*.5*S,this.posture.roll*se.postureHipRoll*S),s.addEuler(this.bones.upperBody2,0,0,-this.posture.roll*se.postureChestRoll*S),s.addEuler(this.bones.head,0,0,-this.posture.roll*se.postureHeadRoll*S)}s.addEuler(this.bones.head,xi(this.time*.31+11.3)*se.microHead*o,xi(this.time*.27+4.1)*se.microHead*o,xi(this.time*.23+71.9)*se.microHead*.6*o),s.addEuler(this.bones.shoulderL,0,0,xi(this.time*.19+5.5)*se.microShoulder*o),s.addEuler(this.bones.shoulderR,0,0,xi(this.time*.21+47.2)*se.microShoulder*o)}}const vi={eyeYaw:et.degToRad(24),eyePitch:et.degToRad(14),headYaw:et.degToRad(34),headPitch:et.degToRad(20)};class m2{constructor(i,s,o){this.model=i,this.bones=s,this.idle=o,this.mode="user",this.target=new ft,this.wanderOffset=new ft,this.wanderTarget=new ft,this.wanderTimer=0,this.wanderNext=0,this.eyeYaw=0,this.eyePitch=0,this.headYaw=0,this.headPitch=0,this.saccadeTimer=0,this.saccadeNext=0,this.saccade=new nl,this.saccadeTargetVec=new nl,this.time=0,this.emotion="idle",this.emotionTime=0,this.emotionOffset=new ft,this.blinkRequested=!1,this._headWorld=new ft,this._targetLocal=new ft,this._dir=new ft,this._euler=new Rh,this._quat=new Ce,this.scheduleSaccade(),this.scheduleWander()}setMode(i){i!==this.mode&&(this.mode=i,this.wanderTimer=this.wanderNext)}get currentMode(){return this.mode}setEmotion(i){i!==this.emotion&&(this.emotion=i,this.emotionTime=0)}lookAt(i){this.target.copy(i),this.mode="point"}consumeBlinkRequest(){const i=this.blinkRequested;return this.blinkRequested=!1,i}scheduleSaccade(){this.saccadeTimer=0,this.saccadeNext=et.randFloat(this.idle.saccadeIntervalMin,this.idle.saccadeIntervalMax)}scheduleWander(){this.wanderTimer=0,this.wanderNext=et.randFloat(2.5,6.5)}update(i,s,o){if(this.time+=i,this.emotionTime+=i,this.wanderTimer+=i,this.wanderTimer>=this.wanderNext){this.scheduleWander();const v=this.mode==="away"?1:.55;this.wanderTarget.set(et.randFloatSpread(14*v),et.randFloatSpread(7*v),et.randFloatSpread(6)),this.wanderTarget.distanceTo(this.wanderOffset)>4&&(this.blinkRequested=!0)}this.wanderOffset.lerp(this.wanderTarget,1-Math.exp(-2.2*i));const r=this.model.bones[this.model.boneIndexByName.get(this.bones.head)??-1];if(!r)return;switch(r.getWorldPosition(this._headWorld),this.mode){case"user":this.target.copy(o);break;case"wander":this.target.copy(o).add(this.wanderOffset);break;case"away":this.target.copy(o).add(this.wanderOffset),this.target.x+=Math.sin(this.time*.38)*6,this.target.y+=(this.emotion==="thinking"?.4:-2.1)+Math.sin(this.time*.71)*.35;break}this.mode!=="point"&&(this.applyEmotionOffset(),this.target.add(this.emotionOffset)),this._targetLocal.copy(this.target),this.model.mesh.worldToLocal(this._targetLocal),this._dir.subVectors(this._targetLocal,this.modelSpaceHeadPosition(r));const h=this._dir.length();if(h<1e-4)return;this._dir.divideScalar(h);const f=Math.atan2(this._dir.x,this._dir.z),d=-Math.asin(et.clamp(this._dir.y,-1,1));this.saccadeTimer+=i,this.saccadeTimer>=this.saccadeNext&&(this.scheduleSaccade(),this.saccadeTargetVec.set(et.randFloatSpread(et.degToRad(6)),et.randFloatSpread(et.degToRad(3)))),this.saccade.lerp(this.saccadeTargetVec,1-Math.exp(-18*i));const g=xi(this.time*.35)*et.degToRad(1.4),m=1-Math.exp(-14*i),y=1-Math.exp(-3.2*i);this.eyeYaw=et.lerp(this.eyeYaw,et.clamp(f+this.saccade.x+g,-vi.eyeYaw,vi.eyeYaw),m),this.eyePitch=et.lerp(this.eyePitch,et.clamp(d+this.saccade.y,-vi.eyePitch,vi.eyePitch),m),this.headYaw=et.lerp(this.headYaw,et.clamp(f*.55,-vi.headYaw,vi.headYaw),y),this.headPitch=et.lerp(this.headPitch,et.clamp(d*.45,-vi.headPitch,vi.headPitch),y),this._euler.set(this.headPitch*.35,this.headYaw*.4,0,"YXZ"),s.addQuaternion(this.bones.neck,this._quat.setFromEuler(this._euler)),this._euler.set(this.headPitch*.65,this.headYaw*.6,0,"YXZ"),s.addQuaternion(this.bones.head,this._quat.setFromEuler(this._euler)),this._euler.set(this.eyePitch,this.eyeYaw,0,"YXZ"),s.addQuaternion(this.bones.eyes,this._quat.setFromEuler(this._euler))}applyEmotionOffset(){const i=this.emotionTime;switch(this.emotionOffset.set(0,0,0),this.emotion){case"embarrassed":this.emotionOffset.set(Math.sin(i*.72)*2.6,-2.2+Math.sin(i*1.1)*.35,0);break;case"thinking":this.emotionOffset.set(Math.sin(i*.34)*3.2,.75,0);break;case"sad":this.emotionOffset.set(Math.sin(i*.36)*.9,-1.5,0);break;case"curious":this.emotionOffset.set(Math.sin(i*.58)*1.8,.75,0);break;case"confused":this.emotionOffset.set(Math.sin(i*.82)*2.1,Math.sin(i*.57)*.3,0);break;case"playful":this.emotionOffset.set(Math.sin(i*1.35)*1.6,.45,0);break;case"excited":this.emotionOffset.set(Math.sin(i*1.2)*1.2,.4+Math.sin(i*1.8)*.2,0);break;case"happy":case"proud":this.emotionOffset.set(Math.sin(i*.55)*.65,.2,0);break}}modelSpaceHeadPosition(i){const s=this.model.boneIndexByName.get(this.bones.head),o=s!==void 0?this.model.boneInfos[s]:void 0;return o?o.position:i.position}}const zc=(a,i,s,o)=>{const r=i==="left"?"L":"R";return a[s+o+r]},Lc=(a,i,s)=>{const o=i==="left"?"L":"R";return a["thumb"+s+o]},p2={relaxed:{index:.12,middle:.16,ring:.2,little:.24},open:{index:.015,middle:.02,ring:.025,little:.03},delicate:{index:.08,middle:.16,ring:.28,little:.38},softFist:{index:.66,middle:.72,ring:.76,little:.8},point:{index:.015,middle:.62,ring:.7,little:.76}};function fe(a,i,s,o,r=1){if(r<=0)return;const h=p2[o],f=s==="left"?1:-1,d=o==="open"?.045:o==="delicate"?.018:0;["index","middle","ring","little"].forEach((y,v)=>{const S=h[y],T=(v-1.5)*d*f;a.addEuler(zc(i,s,y,1),S*.58,0,T,r),a.addEuler(zc(i,s,y,2),S*.82,0,0,r),a.addEuler(zc(i,s,y,3),S*.62,0,0,r)});const m=o==="open"?.02:o==="softFist"?.5:o==="point"?.42:.16;a.addEuler(Lc(i,s,0),m*.28,f*m*.34,0,r),a.addEuler(Lc(i,s,1),m*.58,f*m*.16,0,r),a.addEuler(Lc(i,s,2),m*.42,0,0,r)}const g2=["idle","listening","thinking","talking"],_c=["happy","excited","curious","thinking","proud","sad","confused","surprised","embarrassed","playful"];class y2{constructor(){this.time=0,this.activityWeights={idle:1,listening:0,thinking:0,talking:0},this.emotionWeights=Object.fromEntries(_c.map(i=>[i,0]))}update({delta:i,activity:s,emotion:o,pose:r,bones:h}){this.time+=i;const f=1-Math.exp(-5.2*i),d=1-Math.exp(-4.6*i);for(const m of g2)this.activityWeights[m]=et.lerp(this.activityWeights[m],m===s?1:0,f);for(const m of _c)this.emotionWeights[m]=et.lerp(this.emotionWeights[m],m===o?1:0,d);fe(r,h,"left","relaxed",.7),fe(r,h,"right","relaxed",.7),this.applyListening(this.activityWeights.listening,r,h);const g=Math.max(this.activityWeights.thinking,this.emotionWeights.thinking*.82);this.applyThinking(g,r,h),this.applyTalking(this.activityWeights.talking,r,h);for(const m of _c){const y=this.emotionWeights[m];y>.001&&this.applyEmotion(m,y,r,h)}}applyListening(i,s,o){if(i<=.001)return;const r=.82+Math.sin(this.time*1.25)*.04;s.addEuler(o.upperBody2,-.025*r,0,0,i),s.addEuler(o.head,-.015,Math.sin(this.time*.55)*.018,.035,i),s.addEuler(o.neck,0,0,.012,i),s.addEuler(o.shoulderL,0,0,.018,i),s.addEuler(o.shoulderR,0,0,-.018,i)}applyThinking(i,s,o){if(i<=.001)return;const r=.94+Math.sin(this.time*.7)*.025;s.addEuler(o.head,-.045,.11,-.065,i),s.addEuler(o.neck,-.015,.035,-.018,i),s.addEuler(o.upperBody2,.018,.035,0,i),s.addEuler(o.shoulderR,0,0,-.055,i),s.addEuler(o.armR,.05,-.28,-.3*r,i),s.addEuler(o.elbowR,.1,.18,2.35,i),s.addEuler(o.wristR,.12,-.16,-.22,i),fe(s,o,"right","point",i*.95)}applyTalking(i,s,o){if(i<=.001)return;const h=this.time/2.8,f=h-Math.floor(h),d=Math.pow(Math.sin(f*Math.PI),2),g=Math.floor(h)%2===0,m=d*i,y=Math.sin(this.time*8.4)*.5+.5;s.addEuler(o.head,y*.012,Math.sin(this.time*.8)*.012,0,i),s.addEuler(o.upperBody2,-.012,Math.sin(this.time*.65)*.018,0,i),g?(s.addEuler(o.armL,0,-.16,.28,m),s.addEuler(o.elbowL,.04,-.3,.11,m),s.addEuler(o.wristL,-.08,.13,Math.sin(f*Math.PI*2)*.06,m),fe(s,o,"left","delicate",m)):(s.addEuler(o.armR,0,.16,-.28,m),s.addEuler(o.elbowR,.04,.3,-.11,m),s.addEuler(o.wristR,-.08,-.13,-Math.sin(f*Math.PI*2)*.06,m),fe(s,o,"right","delicate",m))}applyEmotion(i,s,o,r){const h=Math.sin(this.time*1.35),f=Math.sin(this.time*.62),d=Math.sin(this.time*3.1),g=.5+.5*Math.sin(this.time*.9);switch(i){case"happy":o.addEuler(r.head,-.015+d*.004,f*.028,f*.035,s),o.addEuler(r.neck,0,f*.01,f*.012,s),o.addEuler(r.upperBody2,-.02,-f*.015,-f*.008,s),o.addEuler(r.shoulderL,0,0,.016+d*.006,s),o.addEuler(r.shoulderR,0,0,-.016-d*.006,s);break;case"excited":o.addTranslation(r.center,0,d*.03+.025,0,s),o.addEuler(r.head,-.018+d*.012,f*.045,f*.02,s),o.addEuler(r.upperBody2,-.025+d*.008,f*.03,0,s),o.addEuler(r.shoulderL,0,0,.055+d*.014,s),o.addEuler(r.shoulderR,0,0,-.055-d*.014,s),o.addEuler(r.armL,0,-.05,.12+d*.025,s),o.addEuler(r.armR,0,.05,-.12-d*.025,s),fe(o,r,"left","open",s),fe(o,r,"right","open",s);break;case"curious":o.addEuler(r.head,-.03+h*.006,-f*.055,f*.13,s),o.addEuler(r.neck,-.006,-f*.018,f*.045,s),o.addEuler(r.upperBody2,-.025,f*.025,-f*.012,s);break;case"thinking":o.addEuler(r.head,-.02,f*.055,-f*.04,s),o.addEuler(r.neck,-.008,f*.018,-f*.012,s);break;case"proud":o.addEuler(r.head,-.06+h*.004,f*.018,-f*.015,s),o.addEuler(r.neck,-.018,f*.008,0,s),o.addEuler(r.upperBody2,-.035,-f*.012,0,s),o.addEuler(r.shoulderL,0,0,.035,s),o.addEuler(r.shoulderR,0,0,-.035,s);break;case"sad":o.addEuler(r.head,.085+h*.008,f*.02,f*.025,s),o.addEuler(r.neck,.025,f*.008,f*.01,s),o.addEuler(r.upperBody2,.05,-f*.012,0,s),o.addEuler(r.shoulderL,0,0,-.045,s),o.addEuler(r.shoulderR,0,0,.045,s),fe(o,r,"left","softFist",s*.35),fe(o,r,"right","softFist",s*.35);break;case"confused":{const m=Math.sin(this.time*.75),y=.025+(.5+.5*m)*.035,v=.025+(.5-.5*m)*.035;o.addEuler(r.head,.015,-m*.07,-m*.12,s),o.addEuler(r.neck,0,-m*.02,-m*.035,s),o.addEuler(r.shoulderL,0,0,y,s),o.addEuler(r.shoulderR,0,0,-v,s);break}case"surprised":o.addEuler(r.head,.035+d*.005,f*.018,0,s),o.addEuler(r.upperBody2,.045,-f*.015,0,s),o.addEuler(r.shoulderL,0,0,.065+g*.01,s),o.addEuler(r.shoulderR,0,0,-.065-g*.01,s),o.addEuler(r.armL,0,-.04,.09,s),o.addEuler(r.armR,0,.04,-.09,s),fe(o,r,"left","open",s),fe(o,r,"right","open",s);break;case"embarrassed":{const m=Math.sin(this.time*.48);o.addTranslation(r.center,m*.02,0,0,s),o.addEuler(r.head,.075+g*.008,m*.095,-m*.055,s),o.addEuler(r.neck,.024,m*.028,-m*.018,s),o.addEuler(r.upperBody2,.032,-m*.025,0,s),o.addEuler(r.shoulderL,0,0,-.052,s),o.addEuler(r.shoulderR,0,0,.052,s),o.addEuler(r.armL,.015,-.1,-.08,s),o.addEuler(r.armR,.015,.1,.08,s),o.addEuler(r.elbowL,0,-.12,-.06,s),o.addEuler(r.elbowR,0,.12,.06,s),fe(o,r,"left","delicate",s*.8),fe(o,r,"right","delicate",s*.8);break}case"playful":{const m=Math.sin(this.time*.9);o.addEuler(r.head,-.025,-.04+m*.035,.08+m*.04,s),o.addEuler(r.neck,-.006,-.015+m*.012,.022+m*.01,s),o.addEuler(r.upperBody2,-.018,-m*.028,m*.018,s),o.addEuler(r.armL,0,-.09,.1+m*.025,s),o.addEuler(r.wristL,0,.1,.1+m*.04,s),fe(o,r,"left","delicate",s*.8);break}}}}class v2{constructor(i){this.entries=[],this._delta=new Ce,this._scaled=new Ce,this._identity=new Ce,this._offset=new ft;const s=[...i.grants].sort((o,r)=>{var d,g;const h=((d=i.boneInfos[o.boneIndex])==null?void 0:d.transformationClass)??0,f=((g=i.boneInfos[r.boneIndex])==null?void 0:g.transformationClass)??0;return h!==f?h-f:o.boneIndex-r.boneIndex});for(const{boneIndex:o,info:r}of s){const h=i.bones[o],f=i.bones[r.parentIndex];!h||!f||!r.affectRotation&&!r.affectPosition||this.entries.push({bone:h,source:f,sourceRest:f.quaternion.clone(),sourceRestPosition:f.position.clone(),ratio:r.ratio,affectRotation:r.affectRotation,affectPosition:r.affectPosition})}}get count(){return this.entries.length}solve(){for(const i of this.entries){const s=i.ratio;if(s!==0){if(i.affectRotation){this._delta.copy(i.sourceRest).invert().multiply(i.source.quaternion);const o=Math.abs(s);s<0&&this._delta.invert(),o>=.999?i.bone.quaternion.multiply(this._delta):(this._scaled.copy(this._identity).slerp(this._delta,o),i.bone.quaternion.multiply(this._scaled))}i.affectPosition&&(this._offset.subVectors(i.source.position,i.sourceRestPosition),i.bone.position.addScaledVector(this._offset,s))}}}get affectedBoneNames(){return this.entries.map(i=>i.bone.name)}}const b2=new ft(0,-1,0);class x2{constructor(i,s){this.model=i,this.config=s,this.nodes=[],this.accumulator=0,this.enabled=!0,this.initialised=!1,this._center=new ft,this._parentQuat=new Ce,this._invParentQuat=new Ce,this._restDir=new ft,this._dir=new ft,this._next=new ft,this._delta=new ft,this._localDir=new ft,this._quat=new Ce,this._axisScratch=new ft,this.build()}get nodeCount(){return this.nodes.length}get groupBreakdown(){const i={};for(const s of this.nodes)i[s.groupName]=(i[s.groupName]??0)+1;return i}resolveGroup(i){for(const[s,o]of Object.entries(this.config.groups))if(o.enabled!==!1&&o.match.some(r=>i.includes(r)))return{name:s,tuning:o};return{name:"fallback",tuning:this.config.fallback}}build(){const i=new Map,s=h=>{const f=i.get(h);if(f!==void 0)return f;const d=this.model.boneInfos[h],g=d&&d.parentIndex>=0?s(d.parentIndex)+1:0;return i.set(h,g),g},o=new Map;this.model.boneInfos.forEach(h=>{if(h.parentIndex>=0){const f=o.get(h.parentIndex)??[];f.push(h.index),o.set(h.parentIndex,f)}});const r=new Set;for(const h of this.model.rigidBodies){if(h.type==="kinematic"||h.boneIndex<0||h.boneIndex>=this.model.bones.length||r.has(h.boneIndex))continue;r.add(h.boneIndex);const f=this.model.bones[h.boneIndex],d=this.model.boneInfos[h.boneIndex];if(!f||!d)continue;const g=o.get(h.boneIndex)??[],m=g.length>0?this.model.boneInfos[g[0]]:void 0;this._axisScratch.copy(m?this._dir.subVectors(m.position,d.position):this._dir.subVectors(h.position,d.position));let y=this._axisScratch.length();if(y<1e-4)continue;const v=this._axisScratch.clone().divideScalar(y),{name:S,tuning:T}=this.resolveGroup(d.name),A=et.clamp(Math.log10(h.mass+1)/1.7,.05,1),N=et.clamp(h.rotationDamping,0,.999);this.nodes.push({bone:f,axis:v,length:y,currentTail:new ft,prevTail:new ft,stiffness:(T.stiffness??.15)*(1.35-A*.5),drag:et.clamp((T.damping??.2)+N*.35,0,.96),gravityPower:(T.gravityScale??1)*this.config.gravity*.0016*(.5+A),restPull:T.restPull??.25,maxAngle:et.degToRad(T.maxAngleDeg??15),amplitude:(T.amplitude??.7)*this.config.globalAmplitude,inertiaScale:T.inertiaScale??1,depth:s(h.boneIndex),groupName:S})}this.nodes.sort((h,f)=>h.depth-f.depth)}reset(){this.model.mesh.updateMatrixWorld(!0);for(const i of this.nodes)i.bone.updateWorldMatrix(!0,!1),i.bone.matrixWorld.decompose(this._center,this._parentQuat,this._dir),this._restDir.copy(i.axis).applyQuaternion(this._parentQuat).normalize(),i.currentTail.copy(this._center).addScaledVector(this._restDir,i.length),i.prevTail.copy(i.currentTail);this.accumulator=0,this.initialised=!0}setEnabled(i){i&&!this.enabled&&this.reset(),this.enabled=i}update(i){if(!this.enabled||this.nodes.length===0)return;if(!this.initialised){this.reset();return}const s=1/this.config.frequency;this.accumulator=Math.min(this.accumulator+i,s*this.config.maxSubSteps);let o=0;for(;this.accumulator>=s&&o<this.config.maxSubSteps;)this.simulate(s),this.accumulator-=s,o++}simulate(i){const s=i*60;for(const o of this.nodes){const r=o.bone,h=r.parent;r.updateWorldMatrix(!1,!1),this._center.setFromMatrixPosition(r.matrixWorld),h?h.getWorldQuaternion(this._parentQuat):this._parentQuat.identity(),this._restDir.copy(o.axis).applyQuaternion(this._parentQuat).normalize(),this._delta.subVectors(o.currentTail,o.prevTail).multiplyScalar((1-o.drag)*o.inertiaScale),this._next.copy(o.currentTail).add(this._delta).addScaledVector(this._restDir,o.stiffness*o.length*s).addScaledVector(b2,o.gravityPower*o.length*s),this._dir.subVectors(this._next,this._center);const f=this._dir.length();f<1e-6?this._dir.copy(this._restDir):this._dir.divideScalar(f),o.restPull>0&&this._dir.lerp(this._restDir,et.clamp(o.restPull*s,0,1)).normalize();const d=et.clamp(this._dir.dot(this._restDir),-1,1),g=Math.acos(d);if(g>o.maxAngle){const m=o.maxAngle/g;this._dir.multiplyScalar(Math.sin(m*g)/Math.sin(g)).addScaledVector(this._restDir,Math.sin((1-m)*g)/Math.sin(g)).normalize()}this._next.copy(this._center).addScaledVector(this._dir,o.length),o.prevTail.copy(o.currentTail),o.currentTail.copy(this._next),this._invParentQuat.copy(this._parentQuat).invert(),this._localDir.copy(this._dir).applyQuaternion(this._invParentQuat).normalize(),this._quat.setFromUnitVectors(o.axis,this._localDir),o.amplitude>=.999?r.quaternion.copy(this._quat):r.quaternion.slerp(this._quat,o.amplitude),r.updateWorldMatrix(!1,!1)}}dispose(){this.nodes=[]}}const Xs=Math.PI*2,Kn=a=>Math.sin(et.clamp(a,0,1)*Math.PI),S2=[{name:"nod",duration:1.5,weight:10,allowedIn:["idle","listening","talking"],pose:(a,i,s,o)=>{const r=1-a*.45,h=Math.sin(a*Xs*1.75)*r;s.addEuler(o.head,h*.085,0,0,i),s.addEuler(o.neck,h*.035,0,0,i)}},{name:"headTilt",duration:3.2,weight:9,allowedIn:["idle","listening","thinking"],expression:{browUp:.2},pose:(a,i,s,o)=>{const r=Kn(a);s.addEuler(o.head,0,0,r*.13,i),s.addEuler(o.neck,0,0,r*.05,i)}},{name:"lookAround",duration:3.6,weight:8,gaze:"wander",blinkOnStart:!0,expression:{browUp:.15},pose:(a,i,s,o)=>{const r=Math.sin(a*Math.PI)*Math.sin(a*Xs*.5);s.addEuler(o.upperBody2,0,r*.05,0,i)}},{name:"lookAtUser",duration:2.8,weight:11,allowedIn:["idle","listening","talking","thinking"],gaze:"user",blinkOnStart:!0,expression:{lowerLidUp:.2,mouthCornerUpL:.15,mouthCornerUpR:.15}},{name:"smile",duration:3,weight:10,allowedIn:["idle","listening","talking"],expression:{smileEyes:.4,lowerLidUp:.28,mouthCornerUpL:.5,mouthCornerUpR:.5,browUp:.15},pose:(a,i,s,o)=>{s.addEuler(o.head,Kn(a)*.02,0,Kn(a)*.03,i)}},{name:"happy",duration:2.6,weight:6,allowedIn:["idle","talking"],expression:{smileEyes:.5,mouthCornerUpL:.65,mouthCornerUpR:.65,browUp:.3},pose:(a,i,s,o)=>{const r=Math.sin(a*Xs*1.5)*(1-a);s.addTranslation(o.center,0,r*.06,0,i),s.addEuler(o.upperBody,-r*.02,0,0,i)}},{name:"curious",duration:3.4,weight:8,allowedIn:["idle","listening"],expression:{browUp:.45,eyesWideL:.2,eyesWideR:.2,mouthNarrow:.15},pose:(a,i,s,o)=>{const r=Kn(a);s.addEuler(o.head,-r*.03,r*.05,r*.15,i),s.addEuler(o.upperBody2,-r*.025,0,0,i)}},{name:"think",duration:4.5,weight:9,allowedIn:["idle","thinking"],gaze:"away",expression:{eyesHalf:.3,browTroubled:.35,mouthNarrow:.25},idleIntensity:.7,pose:(a,i,s,o)=>{const r=Kn(a);s.addEuler(o.head,-r*.06,r*.12,-r*.08,i),s.addEuler(o.neck,-r*.02,r*.04,0,i)}},{name:"wave",duration:3.4,weight:5,allowedIn:["idle"],gaze:"user",expression:{smileEyes:.35,mouthCornerUpL:.55,mouthCornerUpR:.55,browUp:.25},idleIntensity:.55,pose:(a,i,s,o)=>{const r=a<.25?f2(a/.25):a>.75?Wi((1-a)/.25):1;s.addEuler(o.armL,0,-.25*r,1.02*r,i),s.addEuler(o.elbowL,0,-.55*r,.32*r,i);const h=Math.sin(a*Xs*3.2)*r;s.addEuler(o.elbowL,0,h*.3,0,i),s.addEuler(o.wristL,0,h*.38,h*.12,i),fe(s,o,"left","open",i*r),s.addEuler(o.upperBody2,0,-.035*r,.02*r,i),s.addEuler(o.head,0,0,.04*r,i)}},{name:"handGesture",duration:2.4,weight:7,allowedIn:["idle","talking"],pose:(a,i,s,o)=>{const r=Kn(a),h=Math.sin(a*Xs*1.6);s.addEuler(o.armL,0,0,r*.09,i),s.addEuler(o.elbowL,0,r*.16,r*.1,i),s.addEuler(o.wristL,h*.13*r,r*.12,0,i),fe(s,o,"left","delicate",i*r)}},{name:"stretch",duration:5,weight:3,allowedIn:["idle"],expression:{smileEyes:.35,browUp:.3},idleIntensity:.4,blinkOnStart:!0,pose:(a,i,s,o)=>{const r=a<.35?Wi(a/.35):a>.6?Wi((1-a)/.4):1;s.addEuler(o.armL,0,-.2*r,.75*r,i),s.addEuler(o.armR,0,.2*r,-.75*r,i),s.addEuler(o.elbowL,0,-.3*r,.2*r,i),s.addEuler(o.elbowR,0,.3*r,-.2*r,i),s.addEuler(o.upperBody,-.06*r,0,0,i),s.addEuler(o.upperBody2,-.05*r,0,0,i),s.addEuler(o.head,-.07*r,0,0,i),s.addTranslation(o.center,0,.09*r,0,i),s.addEuler(o.shoulderL,0,0,.09*r,i),s.addEuler(o.shoulderR,0,0,-.09*r,i),fe(s,o,"left","open",i*r),fe(s,o,"right","open",i*r)}},{name:"shiftWeight",duration:4.2,weight:8,allowedIn:["idle","listening","thinking"],pose:(a,i,s,o)=>{const r=Kn(a);s.addTranslation(o.center,r*.14,0,0,i),s.addEuler(o.waist,0,r*.03,r*.035,i),s.addEuler(o.upperBody,0,0,-r*.025,i),s.addEuler(o.head,0,0,-r*.02,i)}},{name:"relaxedPose",duration:5.5,weight:6,allowedIn:["idle"],expression:{eyesHalf:.15,mouthCornerUpL:.2,mouthCornerUpR:.2},idleIntensity:.8,pose:(a,i,s,o)=>{const r=Kn(a);s.addEuler(o.shoulderL,0,0,-r*.05,i),s.addEuler(o.shoulderR,0,0,r*.05,i),s.addEuler(o.upperBody,r*.022,0,0,i),s.addEuler(o.head,r*.028,0,0,i)}},{name:"glanceAside",duration:2.2,weight:7,allowedIn:["idle","thinking"],gaze:"wander",blinkOnStart:!0,pose:(a,i,s,o)=>{const r=Kn(a),h=1;s.addEuler(o.head,0,r*.14*h,r*.03*h,i),s.addEuler(o.neck,0,r*.05*h,0,i)}}];class kh{constructor(i,s=S2){this.config=i,this.library=s,this.active=null,this.timer=0,this.next=0,this.recent=[],this.blinkRequested=!1,this.enabled=!0,this.schedule("idle")}setConfig(i){this.config=i}setEnabled(i){this.enabled=i,!i&&this.active&&(this.active.releasing=!0)}get currentName(){var i;return((i=this.active)==null?void 0:i.behaviour.name)??null}schedule(i){this.timer=0;const s=i==="idle"?1:this.config.busyIntervalScale;this.next=et.randFloat(this.config.intervalMin,this.config.intervalMax)*s}pick(i){const s=this.library.filter(f=>(f.allowedIn??["idle"]).includes(i)?!this.recent.includes(f.name):!1),o=s.length>0?s:this.library.filter(f=>(f.allowedIn??["idle"]).includes(i));if(o.length===0)return null;const r=o.reduce((f,d)=>f+d.weight,0);let h=Math.random()*r;for(const f of o)if(h-=f.weight,h<=0)return f;return o[o.length-1]}trigger(i){const s=this.library.find(o=>o.name===i);return s?(this.begin(s),!0):!1}begin(i){for(this.active={behaviour:i,elapsed:0,weight:0,releasing:!1},i.blinkOnStart&&(this.blinkRequested=!0),this.recent.push(i.name);this.recent.length>this.config.noRepeatWindow;)this.recent.shift()}static envelope(i,s,o){const r=Math.min(.45,i.duration*.25);if(o)return 0;const h=r>0?Wi(s/r):1,f=i.duration-s,d=r>0?Wi(f/r):1;return Math.min(h,d,1)}update(i){var f,d;const{delta:s,activity:o,pose:r,bones:h}=i;if(this.active){const g=this.active;if(g.elapsed+=s,g.releasing?(g.weight=Math.max(0,g.weight-s*3),g.weight<=.001&&(this.active=null,this.schedule(o))):!(g.behaviour.allowedIn??["idle"]).includes(o)||!this.enabled||g.elapsed>=g.behaviour.duration?g.releasing=!0:g.weight=kh.envelope(g.behaviour,g.elapsed,!1),this.active&&g.weight>0){const m=et.clamp(g.elapsed/g.behaviour.duration,0,1);(d=(f=g.behaviour).pose)==null||d.call(f,m,g.weight,r,h)}return}if(this.enabled&&(this.timer+=s,this.timer>=this.next)){const g=this.pick(o);g?this.begin(g):this.schedule(o)}}get overlay(){var i;return(i=this.active)==null?void 0:i.behaviour.expression}get overlayWeight(){var i;return((i=this.active)==null?void 0:i.weight)??0}get gazeOverride(){if(this.active&&this.active.weight>.25)return this.active.behaviour.gaze}get idleIntensity(){if(!this.active)return 1;const i=this.active.behaviour.idleIntensity??1;return et.lerp(1,i,this.active.weight)}consumeBlinkRequest(){const i=this.blinkRequested;return this.blinkRequested=!1,i}}const w2=1/20;class T2{constructor(i){this.model=null,this.lighting=null,this.morphs=null,this.face=null,this.pose=null,this.idle=null,this.performance=null,this.gaze=null,this.grants=null,this.physics=null,this.behaviours=null,this.clock=new Cx,this.rafHandle=0,this.running=!1,this.disposed=!1,this.lastFrameTime=0,this.speechAuthority=0,this.currentActivity="idle",this.reflectionStrength=1,this.focusPoint=new ft,this.pointerNdc=new nl,this.gazePoint=new ft,this.eyeTracking=!0,this.frameInput={activity:"idle",emotion:"idle",outputAnalyser:null,inputAnalyser:null},this.tick=()=>{var h;if(!this.running||this.disposed)return;this.rafHandle=requestAnimationFrame(this.tick);const s=performance.now(),o=1e3/this.config.render.targetFps-1;if(s-this.lastFrameTime<o)return;const r=Math.min((s-this.lastFrameTime)/1e3,w2);this.lastFrameTime=s;try{this.update(r)}catch(f){(h=this.onError)==null||h.call(this,f instanceof Error?f:new Error(String(f))),this.stop()}},this.config=i.config,this.onProgress=i.onProgress,this.onError=i.onError,this.stage=new a2(i.canvas,this.config.render,this.config.camera),this.lipSync=new u2(this.config.lipSync)}get isLoaded(){return this.model!==null}get diagnostics(){var i,s,o,r,h,f,d,g,m;return{character:this.config.displayName,loaded:this.isLoaded,bones:((i=this.model)==null?void 0:i.bones.length)??0,vertexMorphs:((s=this.model)==null?void 0:s.vertexMorphs.size)??0,boneMorphs:((o=this.model)==null?void 0:o.boneMorphs.size)??0,physicsNodes:((r=this.physics)==null?void 0:r.nodeCount)??0,physicsGroups:((h=this.physics)==null?void 0:h.groupBreakdown)??{},grants:((f=this.grants)==null?void 0:f.count)??0,behaviour:((d=this.behaviours)==null?void 0:d.currentName)??null,expression:((g=this.face)==null?void 0:g.expression)??null,gaze:((m=this.gaze)==null?void 0:m.currentMode)??null}}async load(){var i,s,o,r;try{const h=await ZS({modelUrl:this.config.modelUrl,textureMapUrl:this.config.textureMapUrl,onProgress:this.onProgress,createMaterial:(v,S)=>{const T=wp(v.name,this.config.materialRoles),A=this.config.materialTuning[T]??{};return $S(v,T,A,S,this.stage.maxAnisotropy)}});if(this.disposed)return;this.model=h,this.applyReflectionStrength();const f=new Zg;f.name=`character:${this.config.id}`,f.scale.setScalar(this.config.scale),f.position.y=this.config.groundOffset;const d=this.config.lighting.shadow.enabled;if(h.mesh.castShadow=d,h.mesh.receiveShadow=d,f.add(h.mesh),(i=this.config.outline)!=null&&i.enabled){const v=e2(h,S=>wp(S,this.config.materialRoles),S=>this.config.materialTuning[S]??{},{scale:this.config.outline.scale??1});v&&f.add(v)}if((s=this.config.hiddenMaterials)!=null&&s.length){const v=new Set(this.config.hiddenMaterials),S=h.mesh.material;h.materials.forEach((T,A)=>{v.has(T.name)&&(S[A].visible=!1)})}this.stage.scene.add(f),this.lighting=new n2(this.config.lighting),this.stage.scene.add(this.lighting.group);const g=new Xg().setFromObject(f),m=g.getCenter(new ft),y=g.getSize(new ft).length()*.5;if(this.lighting.frame(m,y),this.morphs=new s2(h),this.pose=new c2(h),this.pose.registerAll(Object.values(this.config.bones)),this.config.basePose)for(const[v,S]of Object.entries(this.config.basePose)){const T=this.config.bones[v];this.pose.bakeIntoRest(T,S.x??0,S.y??0,S.z??0)}this.grants=new v2(h);for(const v of this.morphs.morphedBones)this.pose.register(v.name);this.pose.registerAll(this.grants.affectedBoneNames),this.face=new r2(this.morphs,this.config.morphs,this.config.idle),this.idle=new d2(this.config.bones,this.config.idle),this.performance=new y2,this.gaze=new m2(h,this.config.bones,this.config.idle),this.behaviours=new kh(this.config.behaviour),this.physics=new x2(h,this.config.physics),h.mesh.updateMatrixWorld(!0),this.physics.reset(),this.updateFocus(),(o=this.onProgress)==null||o.call(this,"Ready",1)}catch(h){throw(r=this.onError)==null||r.call(this,h instanceof Error?h:new Error(String(h))),h}}setFrameInput(i){Object.assign(this.frameInput,i)}setPointer(i,s){this.pointerNdc.set(i,s),this.stage.setPointer(i,s)}triggerBehaviour(i){if(!this.behaviours)return!1;this.frameInput.emotion="idle";this.behaviours.setEnabled(!0);return this.behaviours.trigger(i)}setExpression(i,s=.45){this.frameInput.emotion=i;if(this.face)this.face.setExpression(i,s)}orbitBy(i,s){this.stage.orbitBy(i,s)}zoomBy(i){this.stage.zoomBy(i)}setViewLocked(i){this.stage.setLocked(i)}get isViewLocked(){return this.stage.isLocked}setReflectionStrength(i){this.reflectionStrength=et.clamp(i,0,2),this.applyReflectionStrength()}applyReflectionStrength(){if(!this.model)return;const i=this.model.mesh.material;for(const s of Array.isArray(i)?i:[i])t2(s,this.reflectionStrength)}resetView(){this.stage.resetView()}setView(i){const s={front:0,threeQuarter:Math.PI*.22,right:Math.PI*.5,back:Math.PI,left:-Math.PI*.5}[i];this.stage.setOrbit(s,0)}setEyeTracking(i){this.eyeTracking=i}get isEyeTracking(){return this.eyeTracking}resize(i,s){this.stage.resize(i,s)}start(){this.running||this.disposed||(this.running=!0,this.clock.start(),this.lastFrameTime=performance.now(),this.tick())}stop(){this.running=!1,this.rafHandle&&cancelAnimationFrame(this.rafHandle),this.rafHandle=0}updateFocus(){const i=this.model;if(!i)return;const s=i.boneIndexByName.get(this.config.camera.targetBone),o=s!==void 0?i.bones[s]:void 0;o?o.getWorldPosition(this.focusPoint):i.mesh.getWorldPosition(this.focusPoint),this.focusPoint.y+=this.config.camera.targetOffset,this.stage.setFocus(this.focusPoint)}update(i){const{model:s,pose:o,morphs:r,face:h,idle:f,performance:d,gaze:g,grants:m,physics:y,behaviours:v,lighting:S}=this;if(!s||!o||!r||!h||!f||!d||!g||!m||!y||!v||!S)return;const T=this.frameInput;this.currentActivity=T.activity;const A=T.activity==="talking";this.speechAuthority=et.lerp(this.speechAuthority,A?1:0,1-Math.exp(-8*i));const N=this.lipSync.update(A?T.outputAnalyser:null,i,A);o.begin(),r.begin();const D=T.emotion!=="idle";if(v.setEnabled(!D),f.setIntensity(v.idleIntensity),f.update(i,o),d.update({delta:i,activity:this.currentActivity,emotion:T.emotion,pose:o,bones:this.config.bones}),v.update({delta:i,activity:this.currentActivity,pose:o,bones:this.config.bones}),g.setEmotion(T.emotion),this.eyeTracking)this.gazePoint.set(this.pointerNdc.x,this.pointerNdc.y,.5).unproject(this.stage.camera).sub(this.stage.camera.position).normalize().multiplyScalar(Math.max(10,this.stage.orbitDistance-2)).add(this.stage.camera.position),g.lookAt(this.gazePoint);else{const X=T.emotion==="embarrassed"||T.emotion==="sad"||T.emotion==="thinking"?"away":T.emotion==="curious"||T.emotion==="confused"?"wander":T.emotion==="idle"?void 0:"user",tt=(D?void 0:v.gazeOverride)??X??(this.currentActivity==="thinking"?"away":this.currentActivity==="idle"?"wander":"user");g.setMode(tt)}g.update(i,o,this.stage.camera.position),o.apply();const _=T.emotion==="idle"&&this.currentActivity==="listening"?"listening":T.emotion==="idle"&&this.currentActivity==="thinking"?"thinking":T.emotion,Y=_==="surprised"||_==="excited"?.24:_==="embarrassed"||_==="sad"?.38:.32;h.setExpression(_,Y),(g.consumeBlinkRequest()||v.consumeBlinkRequest())&&h.triggerBlink(),h.update({delta:i,visemes:N,speechAuthority:this.speechAuthority,overlay:D?void 0:v.overlay,overlayWeight:D?0:v.overlayWeight}),r.commitVertexMorphs(),r.commitBoneMorphs(),m.solve(),s.mesh.updateMatrixWorld(!0),y.update(i),this.updateFocus(),this.stage.update(i),S.update(this.stage.camera),this.stage.render()}dispose(){var i,s,o,r;if(!this.disposed){if(this.disposed=!0,this.stop(),(i=this.physics)==null||i.dispose(),(s=this.lighting)==null||s.dispose(),this.model){this.model.mesh.geometry.dispose();const h=this.model.mesh.material;for(const f of Array.isArray(h)?h:[h]){const d=f;(o=d.map)==null||o.dispose(),(r=d.gradientMap)==null||r.dispose(),d.dispose()}this.stage.scene.clear(),this.model=null}this.stage.dispose()}}}const nh={id:"bikli",displayName:"BIKLI",modelUrl:"/assets/characters/bikli/model.pmx",textureMapUrl:"/assets/characters/bikli/textures.json",scale:1,groundOffset:0,bones:{root:"全ての親",center:"センター",groove:"グルーブ",waist:"腰",lowerBody:"下半身",upperBody:"上半身",upperBody2:"上半身2",neck:"首",head:"頭",eyes:"両目",eyeL:"左目",eyeR:"右目",shoulderL:"左肩",shoulderR:"右肩",armL:"左腕",armR:"右腕",elbowL:"左ひじ",elbowR:"右ひじ",wristL:"左手首",wristR:"右手首",thumb0L:"左親指０",thumb1L:"左親指１",thumb2L:"左親指２",index1L:"左人指１",index2L:"左人指２",index3L:"左人指３",middle1L:"左中指１",middle2L:"左中指２",middle3L:"左中指３",ring1L:"左薬指１",ring2L:"左薬指２",ring3L:"左薬指３",little1L:"左小指１",little2L:"左小指２",little3L:"左小指３",thumb0R:"右親指０",thumb1R:"右親指１",thumb2R:"右親指２",index1R:"右人指１",index2R:"右人指２",index3R:"右人指３",middle1R:"右中指１",middle2R:"右中指２",middle3R:"右中指３",ring1R:"右薬指１",ring2R:"右薬指２",ring3R:"右薬指３",little1R:"右小指１",little2R:"右小指２",little3R:"右小指３",legL:"左足",legR:"右足",kneeL:"左ひざ",kneeR:"右ひざ",ankleL:"左足首",ankleR:"右足首"},basePose:{armL:{z:-.58,y:.1},armR:{z:.58,y:-.1},elbowL:{z:-.14,y:.22},elbowR:{z:.14,y:-.22},wristL:{z:-.05,y:.1},wristR:{z:.05,y:-.1},shoulderL:{z:-.04},shoulderR:{z:.04}},outline:{enabled:!1,scale:1},morphs:{blink:"まばたき",blinkL:"ウィンク",blinkR:"ウィンク右",smileEyes:"笑い",eyesWideL:"びっくり左",eyesWideR:"びっくり右",eyesHalf:"じと目",eyesAngry:"怒り目",eyesAngry2:"怒り目２",eyesSad:"悲しむ",eyeOuterDown:"眼角下",lowerLidUp:"下眼上",visemeA:"あ",visemeI:"い",visemeU:"う",visemeE:"え",visemeO:"お",visemeTalk:"ワ",mouthSmile:"にやり",mouthCornerUpL:"口角上げ左",mouthCornerUpR:"口角上げ右",mouthCornerDownL:"口角下げ左",mouthCornerDownR:"口角下げ右",mouthWiden:"口横広げ",mouthNarrow:"口横狭め",mouthShiftRight:"口右",mouthShiftLeft:"口左",mouthUp:"口上",mouthDown:"口下",mouthWidenL:"口横広げ左",mouthWidenR:"口横広げ右",mouthNarrowL:"口横狭め左",mouthNarrowR:"口横狭め右",teethUp:"齒上",teethDown:"齒下",browAngry:"怒り",browSerious:"真面目",browSad:"悲しい",browTroubled:"困る",browUp:"上",browDown:"下",browAngryR:"怒り右"},materialRoles:{skin:["肌"],face:["颜","痣"],eyeWhite:["白目"],iris:["目"],catchlight:["目光","目光2"],eyeShadow:["目影"],lash:["睫","眉睫影"],brow:["眉"],mouth:["口"],teeth:["齿"],tongue:["舌"],hair:["发","侧发"],frontHair:["前发"],metal:["金属"],jewelry:["珠宝"],leather:["皮裤","黑丝衣","胸衣"],lightCloth:["衬衣"],cloth:["衣","外套","外套+","领带","领带+","发带","穗","武器"]},materialTuning:{skin:{shadowTint:14129811,lightTint:16773609,shadowMid:.56,secondShadow:.18,shadingSoftness:.4,shadowStrength:.72,shadowReceive:.55,minLight:.3,viewKeyStrength:.84,brightness:.97,localContrast:.12,bounceStrength:.24,bounceTint:.5,warmth:.26,aoStrength:.68,rimStrength:.14,rimPower:3.2,rimColor:16767428,specularStrength:.06,specularPower:24,subsurfaceStrength:.3,subsurfaceColor:16748395,outlineWidth:.4,outlineColor:7162440},face:{lightingRig:"face",shadowReceive:.38,minLight:.7,bounceStrength:.28,bounceTint:.55,warmth:.28,brightness:.99,localContrast:.12,shadowTint:14854816,lightTint:16774638,shadowMid:.63,secondShadow:.14,shadingSoftness:.5,shadowStrength:.7,aoStrength:.6,rimStrength:.14,rimPower:3.6,rimColor:16767428,specularStrength:.06,specularPower:28,subsurfaceStrength:.34,subsurfaceColor:16748395,outlineWidth:.22,outlineColor:8016464},eyeWhite:{lightingRig:"face",shadowReceive:0,minLight:.84,shadowTint:11844308,lightTint:16777215,shadowMid:.55,secondShadow:.14,shadingSoftness:.45,shadowStrength:.6,aoStrength:.5,specularStrength:.05,saturation:1,brightness:.72,outlineWidth:0},iris:{lightingRig:"face",shadowReceive:0,minLight:.92,bounceStrength:0,shadowTint:6970016,lightTint:16777215,shadowMid:.44,secondShadow:.28,shadingSoftness:.4,shadowStrength:.6,brightness:.98,specularStrength:.62,specularPower:140,specularWhiteness:1,eyeReflectionStrength:.42,rimStrength:.3,rimPower:2.4,rimWhiteness:.9,rimColor:14673151,emissiveStrength:.1,aoStrength:.25,localContrast:.4,outlineWidth:0},catchlight:{unlit:!0,blend:"blend",emissiveStrength:1,aoStrength:0,outlineWidth:0},eyeShadow:{lightingRig:"face",shadowReceive:0,minLight:.55,bounceStrength:0,shadingSoftness:.2,shadowStrength:.15,outlineWidth:0},lash:{lightingRig:"face",shadowReceive:0,minLight:.5,bounceStrength:0,specularStrength:0,shadingSoftness:.25,shadowStrength:.2,outlineWidth:0},brow:{lightingRig:"face",shadowReceive:0,minLight:.5,bounceStrength:0,specularStrength:0,shadingSoftness:.2,shadowStrength:.16,outlineWidth:0},mouth:{shadingSoftness:.4,shadowStrength:.25,specularStrength:.12,outlineWidth:0},teeth:{shadingSoftness:.25,shadowStrength:.18,specularStrength:.08,outlineWidth:0},tongue:{shadingSoftness:.4,shadowStrength:.28,specularStrength:.18,outlineWidth:0},hair:{shadowTint:11442808,lightTint:16244668,shadowMid:.54,secondShadow:.28,shadingSoftness:.24,shadowStrength:.68,shadowReceive:.62,minLight:.48,brightness:.97,localContrast:.12,viewFillStrength:.68,viewTopStrength:.16,viewKeyStrength:.9,frontFillTint:.08,aoStrength:.76,specularWhiteness:.18,rimWhiteness:.14,rimStrength:.14,rimPower:3.2,rimColor:16773346,specularStrength:.045,specularPower:38,anisotropicStrength:.14,anisotropicShift:.18,outlineWidth:.5,outlineColor:2892595},frontHair:{shadowTint:12165241,lightTint:16113081,shadowMid:.44,secondShadow:.14,shadingSoftness:.34,shadowStrength:.52,shadowReceive:.36,minLight:.62,brightness:.98,localContrast:.1,viewKeyStrength:.92,viewFillStrength:.72,viewTopStrength:.16,frontFillTint:.08,aoStrength:.64,specularWhiteness:.18,rimWhiteness:.14,rimStrength:.12,rimPower:3.2,rimColor:16773336,specularStrength:.045,specularPower:40,anisotropicStrength:.16,anisotropicShift:.16,outlineWidth:.45,outlineColor:3812656},lightCloth:{shadowTint:10265784,lightTint:16773864,shadowMid:.5,secondShadow:.16,shadingSoftness:.36,shadowStrength:.68,shadowReceive:.68,minLight:.28,viewKeyStrength:.82,viewFillStrength:.72,brightness:.96,localContrast:.1,aoStrength:.62,specularWhiteness:.08,rimWhiteness:.08,rimStrength:.14,rimPower:3.6,rimColor:15134203,specularStrength:.055,specularPower:24,outlineWidth:.48,outlineColor:3420475},cloth:{shadowTint:8884912,lightTint:16775408,shadowMid:.52,secondShadow:.28,shadingSoftness:.3,shadowStrength:.84,brightness:.99,localContrast:.14,aoStrength:.72,specularWhiteness:.15,rimWhiteness:.12,rimStrength:.26,rimPower:3.4,rimColor:15134203,specularStrength:.1,specularPower:20,outlineWidth:.6,outlineColor:2367278},leather:{shadowTint:9015466,lightTint:16774895,shadowMid:.48,secondShadow:.24,shadingSoftness:.28,shadowStrength:.82,shadowReceive:.7,minLight:.34,viewKeyStrength:.86,viewFillStrength:1.15,brightness:1.03,localContrast:.1,aoStrength:.68,specularStrength:.22,specularPower:14,specularWhiteness:.34,rimStrength:.2,rimPower:3.2,rimWhiteness:.24,rimColor:15134203,sphereStrength:.3,outlineWidth:.6,outlineColor:1841190},metal:{specularWhiteness:.9,rimWhiteness:.8,shadingSoftness:.18,shadowStrength:.55,rimStrength:.3,rimPower:2.2,specularStrength:.4,specularPower:48,outlineWidth:.45,outlineColor:1972774},jewelry:{specularWhiteness:1,rimWhiteness:.85,shadingSoftness:.14,shadowStrength:.5,rimStrength:.34,rimPower:2,specularStrength:.5,specularPower:64,emissiveStrength:.06,outlineWidth:.3,outlineColor:1972774}},camera:{targetBone:"上半身2",targetOffset:1.2,distance:22,fov:30,heightOffset:.4,parallax:.055,minDistance:8,maxDistance:40},lighting:{keyIntensity:.74,keyColor:16773340,keyAzimuth:22,keyElevation:18,fillIntensity:.2,fillColor:13491455,fillAzimuth:-62,fillElevation:4,rimIntensity:.12,rimColor:15922943,rimAzimuth:156,rimElevation:34,hairLightIntensity:.07,hairLightColor:15660287,frontFillIntensity:.24,frontFillColor:16773862,face:{keyAzimuth:18,keyElevation:11,keyIntensity:.64,keyColor:16773340,fillIntensity:.33,fillColor:16774378,topIntensity:.08,topColor:15922943,rimIntensity:.06,rimColor:15265535,bounceIntensity:.11,bounceColor:16767419},ambientIntensity:.15,ambientSkyColor:11451350,ambientGroundColor:7035474,environmentIntensity:.14,shadow:{enabled:!0,mapSize:4096,radius:8,bias:-6e-4,normalBias:.05,opacity:.28}},render:{exposure:1,toneMapping:"neutral",bloom:{enabled:!1,strength:.34,radius:.65,threshold:.82},antialias:!0,maxPixelRatio:2,targetFps:60},physics:{frequency:60,maxSubSteps:3,gravity:9.8,globalAmplitude:1,groups:{ribbon:{match:["发带"],amplitude:.95,stiffness:.09,damping:.16,restPull:.12,maxAngleDeg:26,gravityScale:1,inertiaScale:1.05},hair:{match:["侧发","刘海","碎发","发穗","后发髻","发结"],amplitude:.8,stiffness:.16,damping:.2,restPull:.26,maxAngleDeg:17,gravityScale:.85,inertiaScale:.95},coat:{match:["外套","中外套"],amplitude:.85,stiffness:.11,damping:.22,restPull:.2,maxAngleDeg:21,gravityScale:1.05,inertiaScale:1},sleeve:{match:["外套袖"],amplitude:.7,stiffness:.15,damping:.24,restPull:.28,maxAngleDeg:15,gravityScale:.9,inertiaScale:.9},tie:{match:["领带"],amplitude:.75,stiffness:.14,damping:.2,restPull:.24,maxAngleDeg:18,gravityScale:1,inertiaScale:.95},chest:{match:["胸"],amplitude:.3,stiffness:.34,damping:.42,restPull:.62,maxAngleDeg:5,gravityScale:.35,inertiaScale:.4},accessory:{match:["耳坠","环珠","背坠","腰环"],amplitude:.8,stiffness:.18,damping:.18,restPull:.22,maxAngleDeg:20,gravityScale:1,inertiaScale:1},lowerBody:{match:["臀","足","ひざ"],amplitude:.25,stiffness:.4,damping:.45,restPull:.6,maxAngleDeg:5,gravityScale:.3,inertiaScale:.35}},fallback:{match:[],amplitude:.6,stiffness:.18,damping:.24,restPull:.3,maxAngleDeg:14,gravityScale:.9,inertiaScale:.85}},idle:{breathRate:.23,breathDepth:1,swayRate:.11,swayAmount:1,postureIntervalMin:7,postureIntervalMax:17,blinkIntervalMin:2.4,blinkIntervalMax:7.5,doubleBlinkChance:.22,saccadeIntervalMin:1.1,saccadeIntervalMax:4.2},behaviour:{intervalMin:6,intervalMax:15,noRepeatWindow:4,busyIntervalScale:2.2},lipSync:{attack:.42,release:.2,gain:1.5,noiseFloor:.035,maxWeight:.92,visemeBlendRate:.3}},Ap={[nh.id]:nh},Mp=nh.id;function A2(a=Mp){return Ap[a]??Ap[Mp]}

export { T2 as BikliCharacterEngine, nh as bikliConfig, S2 as BIKLI_BEHAVIOURS, _c as BIKLI_EMOTIONS, g2 as BIKLI_ACTIVITIES };
