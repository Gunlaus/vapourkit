// Vapourkit SDR shader. Distributed under the project GPL-3.0 license.

//!PARAM GAIN
//!DESC Exposure gain
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 3
1

//!PARAM GAMMA
//!DESC Gamma
//!TYPE float
//!MINIMUM 0.2
//!MAXIMUM 3
1

//!PARAM CONTRAST
//!DESC Contrast
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 3
1

//!PARAM SATURATION
//!DESC Saturation
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 3
1

//!DESC Color Controls
//!HOOK MAIN
//!BIND HOOKED
vec4 hook() { vec4 c=HOOKED_tex(HOOKED_pos); vec3 rgb=pow(max(c.rgb*GAIN,vec3(0.0)),vec3(1.0/GAMMA)); rgb=(rgb-0.5)*CONTRAST+0.5; float y=dot(rgb,vec3(0.2126,0.7152,0.0722)); return vec4(clamp(mix(vec3(y),rgb,SATURATION),0.0,1.0),c.a); }
