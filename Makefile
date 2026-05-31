EMCC     = emcc

# WebAssembly optimizations: Max speed (-O3), Link-Time Optimization (-flto), and relaxed math (-ffast-math)
CXXFLAGS = -O3 -flto -ffast-math -std=c++17

# Expose the necessary C++ functions to the JavaScript bridge
EXPORTS  = '["_update","_initUniformDust","_initGalaxyCollision","_initBinaryStar","_getParticleBuffer","_getParticleCount","_getNodeBuffer","_getNodeCount","_addParticle","_setTheta"]'
RUNTIME  = '["ccall","cwrap"]'

wasm:
	$(EMCC) $(CXXFLAGS) \
	  -s WASM=1 \
	  -s ALLOW_MEMORY_GROWTH=1 \
	  -s EXPORTED_FUNCTIONS=$(EXPORTS) \
	  -s EXPORTED_RUNTIME_METHODS=$(RUNTIME) \
	  -s ENVIRONMENT='web' \
	  cosmosim.cpp -o cosmosim.js
	# Copy artifacts to docs/ to serve the frontend via GitHub Pages
	mkdir -p docs
	cp cosmosim.js cosmosim.wasm docs/

native:
	g++ -O2 -std=c++17 -o cosmosim_native cosmosim.cpp

serve:
	python3 -m http.server 8080

clean:
	rm -f cosmosim.js cosmosim.wasm cosmosim_native

.PHONY: wasm native serve clean