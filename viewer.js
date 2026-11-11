import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';

const $ = id => document.getElementById(id);
const host=$('canvas-host'), load=$('load-state');
let renderer,scene,camera,controls,assembly,grid,meshes=[],selected=null,currentId='provincial',requestId=0;
let modelSpan=300,selectedView='iso',pointerStart=null;
let wireframe=false,transparent=false;

function failure(message){load.hidden=false;load.querySelector('.spinner')?.remove();load.querySelector('strong').textContent='暂时无法显示模型';$('load-detail').textContent=message;}
function init(){
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  host.appendChild(renderer.domElement);
  scene=new THREE.Scene();
  camera=new THREE.PerspectiveCamera(38,1,.1,10000);
  controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=.08;controls.autoRotateSpeed=.65;
  controls.maxPolarAngle=Math.PI*.92;
  controls.addEventListener('start',()=>{document.querySelectorAll('[data-view]').forEach(b=>b.classList.remove('active'));});
  scene.add(new THREE.HemisphereLight(0xe6f2ff,0x747d8d,2.4));
  for(const [position,intensity] of [[[2,4,3],3.2],[[-3,2,-2],1.8]]){
    const light=new THREE.DirectionalLight(0xffffff,intensity);light.position.set(...position);scene.add(light);
  }
  new ResizeObserver(resize).observe(host);
  renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
  renderer.domElement.addEventListener('pointerdown',event=>{pointerStart={x:event.clientX,y:event.clientY};});
  renderer.domElement.addEventListener('pointerup',event=>{
    if(!pointerStart || Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>5)return;
    const rect=renderer.domElement.getBoundingClientRect();
    const pointer=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    const ray=new THREE.Raycaster();ray.setFromCamera(pointer,camera);
    select(ray.intersectObjects(meshes.filter(mesh=>mesh.visible),false)[0]?.object||null);
  });
}
function resize(){
  if(!renderer)return;
  const width=host.clientWidth,height=host.clientHeight;
  renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
}
async function fetchBinary(id,manifest){
  const compressed=typeof DecompressionStream!=='undefined';
  if(!compressed&&manifest.binaryChunks){
    const chunks=[];let size=0;
    for(const file of manifest.binaryChunks){const response=await fetch(`./${file}`);if(!response.ok)throw new Error('模型下载失败，请刷新后重试。');const bytes=new Uint8Array(await response.arrayBuffer());chunks.push(bytes);size+=bytes.length;}
    const all=new Uint8Array(size);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}return all.buffer;
  }
  const response=await fetch(`./${id}.bin${compressed?'.gz':''}`);
  if(!response.ok)throw new Error('模型下载失败，请刷新后重试。');
  const length=Number(response.headers.get('Content-Length'))||0;
  let buffer;
  if(response.body){
    const reader=response.body.getReader(),chunks=[];let received=0;
    while(true){const {value,done}=await reader.read();if(done)break;chunks.push(value);received+=value.byteLength;
      $('load-detail').textContent=length?`正在下载模型 ${Math.min(100,Math.round(received/length*100))}%`:'正在下载模型…';}
    const bytes=new Uint8Array(received);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}buffer=bytes.buffer;
  }else buffer=await response.arrayBuffer();
  const head=new Uint8Array(buffer,0,Math.min(2,buffer.byteLength));
  if(head[0]===0x1f&&head[1]===0x8b){
    $('load-detail').textContent='正在准备三维场景…';
    buffer=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return buffer;
}
async function getModel(id){
  const response=await fetch(`./${id}.json`);if(!response.ok)throw new Error('找不到此版本的模型。');
  const manifest=await response.json();const buffer=await fetchBinary(id,manifest);
  return {manifest,buffer};
}
function disposeAssembly(){
  if(!assembly)return;scene.remove(assembly);
  for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}
  if(grid){scene.remove(grid);grid.geometry.dispose();grid.material.dispose();}
  meshes=[];selected=null;assembly=null;grid=null;
}
function build({manifest,buffer}){
  disposeAssembly();assembly=new THREE.Group();
  const sourceCenter=new THREE.Vector3(...manifest.bounds[0]).add(new THREE.Vector3(...manifest.bounds[1])).multiplyScalar(.5);
  for(const [index,part] of manifest.meshes.entries()){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(buffer,part.positions.offset,part.positions.count),3));
    if(part.normals)geometry.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(buffer,part.normals.offset,part.normals.count),3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer,part.indices.offset,part.indices.count),1));
    if(!part.normals)geometry.computeVertexNormals();
    const rawColors=new Uint8Array(buffer,part.colors.offset,part.colors.count),colors=new Float32Array(rawColors.length);
    for(let c=0;c<colors.length;c++){const v=rawColors[c]/255;colors[c]=v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    geometry.computeBoundingBox();
    const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.5,metalness:.15,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geometry,material);mesh.name=part.name;mesh.visible=part.visible!==false;
    mesh.userData={index,explodeDirection:geometry.boundingBox.getCenter(new THREE.Vector3()).sub(sourceCenter).normalize()};
    if(mesh.userData.explodeDirection.lengthSq()<.01)mesh.userData.explodeDirection.set(0,0,1);
    assembly.add(mesh);meshes.push(mesh);
  }
  // The source SolidWorks assemblies use Y as their vertical axis.
  assembly.updateMatrixWorld(true);
  const box=new THREE.Box3();for(const mesh of meshes)if(mesh.visible)box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  const center=box.getCenter(new THREE.Vector3());
  assembly.position.sub(center);scene.add(assembly);assembly.updateMatrixWorld(true);
  const size=box.getSize(new THREE.Vector3());modelSpan=Math.max(size.x,size.y,size.z);
  grid=new THREE.GridHelper(modelSpan*2.4,20,0xcbd9ea,0xdde7f2);grid.position.y=-size.y/2-.8;grid.material.transparent=true;grid.material.opacity=.7;scene.add(grid);
  $('mesh-count').textContent=manifest.componentCount||manifest.meshCount;
  $('part-search').value='';$('explode').value=0;$('explode-value').value='0%';
  wireframe=false;transparent=false;controls.autoRotate=false;
  for(const id of ['wireframe','transparent','rotate'])$(id).setAttribute('aria-pressed','false');
  renderParts();select(null);setView('iso');
}
async function chooseModel(id,updateHash=true){
  const seq=++requestId;currentId=id;
  disposeAssembly();
  document.querySelectorAll('[data-model]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.model===id)));
  $('model-workspace').setAttribute('aria-labelledby',`tab-${id}`);
  const label=id==='national'?'国赛总装':'省赛整车';
  $('stage-title').textContent=label;$('version-title').textContent=label;
  $('version-description').textContent=id==='national'?'国赛阶段的结构总装模型。':'省赛阶段的整车装配模型。';
  if(updateHash)history.replaceState(null,'',`#${id}`);
  load.hidden=false;$('load-detail').textContent='正在载入，请稍候…';
  try{const model=await getModel(id);if(seq!==requestId)return;build(model);load.hidden=true;document.body.dataset.modelLoaded=id;}
  catch(error){if(seq===requestId)failure(error.message);}
}
function setView(view){
  if(!camera)return;selectedView=view;
  const ratio=Math.max(1,1/camera.aspect);const distance=modelSpan*1.72*ratio;
  const directions={iso:new THREE.Vector3(1,.8,1.15),front:new THREE.Vector3(0,.15,1),top:new THREE.Vector3(0,1,.001)};
  controls.target.set(0,0,0);camera.position.copy(directions[view].normalize().multiplyScalar(distance));
  camera.near=modelSpan/1000;camera.far=modelSpan*50;camera.updateProjectionMatrix();
  controls.minDistance=modelSpan*.2;controls.maxDistance=modelSpan*12;controls.update();
  document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view===view));
}
function renderParts(){
  const query=$('part-search').value.trim().toLowerCase();const fragment=document.createDocumentFragment();let count=0;
  meshes.forEach(mesh=>{
    if(!mesh.name.toLowerCase().includes(query))return;
    const button=document.createElement('button');button.textContent=mesh.name;button.title=mesh.name;
    button.classList.toggle('selected',selected===mesh);button.classList.toggle('is-hidden',!mesh.visible);
    button.setAttribute('aria-pressed',String(selected===mesh));button.addEventListener('click',()=>select(mesh));
    fragment.appendChild(button);count++;
  });
  if(!count){const p=document.createElement('p');p.className='empty-state';p.textContent='没有匹配的零件';fragment.appendChild(p);}
  $('part-list').replaceChildren(fragment);
}
function select(mesh){
  if(selected){selected.material.emissive.setHex(0);selected.material.emissiveIntensity=0;}
  selected=mesh;
  if(selected){selected.material.emissive.setHex(0x2763c1);selected.material.emissiveIntensity=.4;}
  $('hide-selected').disabled=!selected||!selected.visible;
  $('selection-status').textContent=selected?`已选：${selected.name}`:'点击模型可以选择零件';renderParts();
}
function toggle(id,callback){const next=$(id).getAttribute('aria-pressed')!=='true';$(id).setAttribute('aria-pressed',String(next));callback(next);}
document.querySelectorAll('[data-model]').forEach(button=>{button.addEventListener('click',()=>chooseModel(button.dataset.model));button.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=button.dataset.model==='provincial'?'national':'provincial';$(`tab-${next}`).focus();chooseModel(next);
});});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$('reset').addEventListener('click',()=>setView('iso'));
$('explode').addEventListener('input',event=>{const amount=Number(event.target.value);$('explode-value').value=`${amount}%`;for(const mesh of meshes)mesh.position.copy(mesh.userData.explodeDirection).multiplyScalar(modelSpan*.5*amount/100);});
$('wireframe').addEventListener('click',()=>toggle('wireframe',value=>{wireframe=value;meshes.forEach(mesh=>{mesh.material.wireframe=value;});}));
$('transparent').addEventListener('click',()=>toggle('transparent',value=>{transparent=value;meshes.forEach(mesh=>{mesh.material.transparent=value;mesh.material.opacity=value?.35:1;mesh.material.depthWrite=!value;});}));
$('rotate').addEventListener('click',()=>toggle('rotate',value=>{if(controls)controls.autoRotate=value;}));
$('part-search').addEventListener('input',renderParts);
$('hide-selected').addEventListener('click',()=>{if(selected){selected.visible=false;select(null);}});
$('show-all').addEventListener('click',()=>{meshes.forEach(mesh=>mesh.visible=true);select(null);});
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('stage').requestFullscreen();}catch{$('selection-status').textContent='此浏览器暂不支持全屏，仍可拖动和缩放模型。';}});
const shareDialog=$('share-dialog');
$('share').addEventListener('click',()=>{$('share-url').value=`${new URL('./',window.location.href).href}#${currentId}`;$('copy-status').textContent='';shareDialog.showModal();});
$('close-share').addEventListener('click',()=>shareDialog.close());
shareDialog.addEventListener('click',event=>{if(event.target===shareDialog){const r=shareDialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)shareDialog.close();}});
$('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('share-url').value);$('copy-status').textContent='链接已复制';}catch{$('share-url').select();$('copy-status').textContent='请选择并复制上方链接';}});
try{init();resize();chooseModel(location.hash==='#provincial'?'provincial':'national',false);}
catch(error){failure('浏览器未能启动三维渲染，请使用支持 WebGL 的浏览器重试。');console.error(error);}
