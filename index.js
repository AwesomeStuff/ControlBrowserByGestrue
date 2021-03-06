class ControllerDataset {
    constructor(numClasses) {
        this.numClasses = numClasses;
    }

    /**
     * Adds an example to the controller dataset.
     * @param {Tensor} example A tensor representing the example. It can be an image,
     *     an activation, or any other type of Tensor.
     * @param {number} label The label of the example. Should be a number.
     */
    addExample(example, label) {
        // One-hot encode the label.
        const y = tf.tidy(
            () => tf.oneHot(tf.tensor1d([label]).toInt(), this.numClasses));

        if (this.xs == null) {
            // For the first example that gets added, keep example and y so that the
            // ControllerDataset owns the memory of the inputs. This makes sure that
            // if addExample() is called in a tf.tidy(), these Tensors will not get
            // disposed.
            this.xs = tf.keep(example);
            this.ys = tf.keep(y);
        } else {
            const oldX = this.xs;
            this.xs = tf.keep(oldX.concat(example, 0));

            const oldY = this.ys;
            this.ys = tf.keep(oldY.concat(y, 0));

            oldX.dispose();
            oldY.dispose();
            y.dispose();
        }
    }
}

// The number of classes we want to predict. In this example, we will be
// predicting 4 classes for up, down, left, and right.
const NUM_CLASSES = 4;
let mobilenet;
let model;
let webcamElement = document.getElementById('webcam');
const controllerDataset = new ControllerDataset(NUM_CLASSES);
const CONTROLS = ['one', 'two', 'three', 'four'];
const totals = [0, 0, 0, 0];

/**
   * Adjusts the video size so we can make a centered square crop without
   * including whitespace.
   * @param {number} width The real width of the video element.
   * @param {number} height The real height of the video element.
   */
function adjustVideoSize(width, height, webcamElement) {
    const aspectRatio = width / height;
    if (width >= height) {
        webcamElement.width = aspectRatio * webcamElement.height;
    } else if (width < height) {
        webcamElement.height = webcamElement.width / aspectRatio;
    }
}

async function loadMobilenet() {
    const mobilenet = await tf.loadModel(
        'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/model.json');

    // Return a model that outputs an internal activation.
    const layer = mobilenet.getLayer('conv_pw_13_relu');
    return tf.model({ inputs: mobilenet.inputs, outputs: layer.output });
}

async function setup(webcamElement) {
    return new Promise((resolve, reject) => {
        const navigatorAny = navigator;
        navigator.getUserMedia = navigator.getUserMedia ||
            navigatorAny.webkitGetUserMedia || navigatorAny.mozGetUserMedia ||
            navigatorAny.msGetUserMedia;
        if (navigator.getUserMedia) {
            navigator.getUserMedia(
                { video: true },
                stream => {
                    webcamElement.srcObject = stream;
                    webcamElement.addEventListener('loadeddata', async () => {
                        adjustVideoSize(
                            webcamElement.videoWidth,
                            webcamElement.videoHeight, webcamElement);
                        resolve();
                    }, false);
                },
                error => {
                    reject();
                });
        } else {
            reject();
        }
    });
}

async function init() {
    try {
        await setup(document.getElementById('webcam'));
    } catch (e) {
        document.getElementById('no-webcam').style.display = 'block';
    }
    mobilenet = await loadMobilenet();

    // Warm up the model. This uploads weights to the GPU and compiles the WebGL
    // programs so the first time we collect data from the webcam it will be
    // quick.
    // tf.tidy(() => mobilenet.predict(webcam.capture()));

    // ui.init();
}
init();




/// ************************ For Event listners ********************** ///
let mouseDown = false;

const upButton = document.getElementById('one');
const downButton = document.getElementById('two');
const leftButton = document.getElementById('three');
const rightButton = document.getElementById('four');
upButton.addEventListener('mousedown', () => handler(0));
upButton.addEventListener('mouseup', () => mouseDown = false);

downButton.addEventListener('mousedown', () => handler(1));
downButton.addEventListener('mouseup', () => mouseDown = false);

leftButton.addEventListener('mousedown', () => handler(2));
leftButton.addEventListener('mouseup', () => mouseDown = false);

rightButton.addEventListener('mousedown', () => handler(3));
rightButton.addEventListener('mouseup', () => mouseDown = false);

async function handler(label) {
    mouseDown = true;
    const className = CONTROLS[label];
    const button = document.getElementById(className);
     const total = document.getElementById(className + '-total');
    while (mouseDown) {
        addExampleHandler(label);
        document.body.setAttribute('data-active', CONTROLS[label]);
         total.innerText = totals[label]++;
        await tf.nextFrame();
    }
    document.body.removeAttribute('data-active');
}

function addExampleHandler(label) {

    tf.tidy(() => {
        const img = capture();
        controllerDataset.addExample(mobilenet.predict(img), label);

        // Draw the preview thumbnail.
        // ui.drawThumb(img, label);
    });
}
function capture() {
    return tf.tidy(() => {
        // Reads the image as a Tensor from the webcam <video> element.
        const webcamImage = tf.fromPixels(webcamElement);

        // Crop the image so we're using the center square of the rectangular
        // webcam.
        const croppedImage = cropImage(webcamImage);

        // Expand the outer most dimension so we have a batch size of 1.
        const batchedImage = croppedImage.expandDims(0);

        // Normalize the image between -1 and 1. The image comes in between 0-255,
        // so we divide by 127 and subtract 1.
        return batchedImage.toFloat().div(tf.scalar(127)).sub(tf.scalar(1));
    });
}

/**
 * Crops an image tensor so we get a square image with no white space.
 * @param {Tensor4D} img An input image Tensor to crop.
 */
function cropImage(img) {
    const size = Math.min(img.shape[0], img.shape[1]);
    const centerHeight = img.shape[0] / 2;
    const beginHeight = centerHeight - (size / 2);
    const centerWidth = img.shape[1] / 2;
    const beginWidth = centerWidth - (size / 2);
    return img.slice([beginHeight, beginWidth, 0], [size, size, 3]);
}

document.getElementById('train').addEventListener('click', async () => {
    await tf.nextFrame();
    await tf.nextFrame();
    train();
  });

  async function train() {
    if (controllerDataset.xs == null) {
      throw new Error('Add some examples before training!');
    }
  
    // Creates a 2-layer fully connected model. By creating a separate model,
    // rather than adding layers to the mobilenet model, we "freeze" the weights
    // of the mobilenet model, and only train weights from the new model.
    model = tf.sequential({
      layers: [
        // Flattens the input to a vector so we can use it in a dense layer. While
        // technically a layer, this only performs a reshape (and has no training
        // parameters).
        tf.layers.flatten({inputShape: [7, 7, 256]}),
        // Layer 1
        tf.layers.dense({
          units: 100,
          activation: 'relu',
          kernelInitializer: 'varianceScaling',
          useBias: true
        }),
        // Layer 2. The number of units of the last layer should correspond
        // to the number of classes we want to predict.
        tf.layers.dense({
          units: NUM_CLASSES,
          kernelInitializer: 'varianceScaling',
          useBias: false,
          activation: 'softmax'
        })
      ]
    });
  
    // Creates the optimizers which drives training of the model.
    const optimizer = tf.train.adam(0.00001);
    // We use categoricalCrossentropy which is the loss function we use for
    // categorical classification which measures the error between our predicted
    // probability distribution over classes (probability that an input is of each
    // class), versus the label (100% probability in the true class)>
    model.compile({optimizer: optimizer, loss: 'categoricalCrossentropy'});
  
    // We parameterize batch size as a fraction of the entire dataset because the
    // number of examples that are collected depends on how many examples the user
    // collects. This allows us to have a flexible batch size.
    const batchSize =
        Math.floor(controllerDataset.xs.shape[0] * 0.05);
    if (!(batchSize > 0)) {
      throw new Error(
          `Batch size is 0 or NaN. Please choose a non-zero fraction.`);
    }
  
    // Train the model! Model.fit() will shuffle xs & ys so we don't have to.
    model.fit(controllerDataset.xs, controllerDataset.ys, {
      batchSize,
      epochs: 20,
      callbacks: {
        onBatchEnd: async (batch, logs) => {
            console.log("Trained");
          //ui.trainStatus('Loss: ' + logs.loss.toFixed(5));
          await tf.nextFrame();
        }
      }
    });
  }

  document.getElementById('predict').addEventListener('click', () => {
    isPredicting = true;
    predict();
  });
  let isPredicting = false;
  
  async function predict() {
    // ui.isPredicting();
    while (isPredicting) {
      const predictedClass = tf.tidy(() => {
        // Capture the frame from the webcam.
        const img = capture();
  
        // Make a prediction through mobilenet, getting the internal activation of
        // the mobilenet model.
        const activation = mobilenet.predict(img);
  
        // Make a prediction through our newly-trained model using the activation
        // from mobilenet as input.
        const predictions = model.predict(activation);
  
        // Returns the index with the maximum probability. This number corresponds
        // to the class the model thinks is the most probable given the input.
        return predictions.as1D().argMax();
      });
  
      const classId = (await predictedClass.data())[0];
      predictedClass.dispose();
      console.log(classId);
      highlightButton(classId);
      //ui.predictClass(classId);
      await tf.nextFrame();
    }
    // ui.donePredicting();
  }
  
  function highlightButton(classId){
    let id = CONTROLS[classId];
    let ele = document.getElementById(id);
    ele.classList.add("btn-primary");

  }


