'use strict'
let dfu = {}

class WebDFUError extends Error {}
const fn = () => {
  dfu.DETACH = 0x00
  dfu.DNLOAD = 0x01
  dfu.UPLOAD = 0x02
  dfu.GETSTATUS = 0x03
  dfu.CLRSTATUS = 0x04
  dfu.GETSTATE = 0x05
  dfu.ABORT = 6

  dfu.appIDLE = 0
  dfu.appDETACH = 1
  dfu.dfuIDLE = 2
  dfu.dfuDNLOAD_SYNC = 3
  dfu.dfuDNBUSY = 4
  dfu.dfuDNLOAD_IDLE = 5
  dfu.dfuMANIFEST_SYNC = 6
  dfu.dfuMANIFEST = 7
  dfu.dfuMANIFEST_WAIT_RESET = 8
  dfu.dfuUPLOAD_IDLE = 9
  dfu.dfuERROR = 10

  dfu.STATUS_OK = 0x0

  dfu.Device = function (device, settings) {
    this.device_ = device
    this.settings = settings
    this.intfNumber = settings['interface'].interfaceNumber
  }

  dfu.findDeviceDfuInterfaces = function (device) {
    let interfaces = []
    for (let conf of device.configurations) {
      for (let intf of conf.interfaces) {
        for (let alt of intf.alternates) {
          if (
            alt.interfaceClass == 0xfe &&
            alt.interfaceSubclass == 0x01 &&
            (alt.interfaceProtocol == 0x01 || alt.interfaceProtocol == 0x02)
          ) {
            let settings = {
              configuration: conf,
              interface: intf,
              alternate: alt,
              name: alt.interfaceName
            }
            interfaces.push(settings)
          }
        }
      }
    }

    return interfaces
  }

  dfu.findAllDfuInterfaces = function () {
    return navigator.usb.getDevices().then(devices => {
      let matches = []
      for (let device of devices) {
        let interfaces = dfu.findDeviceDfuInterfaces(device)
        for (let interface_ of interfaces) {
          matches.push(new dfu.Device(device, interface_))
        }
      }
      return matches
    })
  }

  dfu.Device.prototype.logDebug = function (msg) {}

  dfu.Device.prototype.logInfo = function (msg) {
    console.log(msg)
  }

  dfu.Device.prototype.logWarning = function (msg) {
    console.log(msg)
  }

  dfu.Device.prototype.logError = function (msg) {
    console.log(msg)
  }

  dfu.Device.prototype.logProgress = function (done, total) {
    if (typeof total === 'undefined') {
      console.log(done)
    } else {
      console.log(done + '/' + total)
    }
  }

  dfu.Device.prototype.open = async function () {
    await this.device_.open()
    const confValue = this.settings.configuration.configurationValue
    if (
      this.device_.configuration === null ||
      this.device_.configuration.configurationValue != confValue
    ) {
      await this.device_.selectConfiguration(confValue)
    }

    const intfNumber = this.settings['interface'].interfaceNumber
    if (!this.device_.configuration.interfaces[intfNumber].claimed) {
      await this.device_.claimInterface(intfNumber)
    }

    const altSetting = this.settings.alternate.alternateSetting
    let intf = this.device_.configuration.interfaces[intfNumber]
    if (
      intf.alternate === null ||
      intf.alternate.alternateSetting != altSetting ||
      intf.alternates.length > 1
    ) {
      try {
        await this.device_.selectAlternateInterface(intfNumber, altSetting)
      } catch (error) {
        if (
          intf.alternate.alternateSetting == altSetting &&
          error.endsWith('Unable to set device interface.')
        ) {
          this.logWarning(
            `Redundant SET_INTERFACE request to select altSetting ${altSetting} failed`
          )
        } else {
          throw error
        }
      }
    }
  }

  dfu.Device.prototype.close = async function () {
    try {
      await this.device_.close()
    } catch (error) {
      console.log(error)
    }
  }

  dfu.Device.prototype.readDeviceDescriptor = function () {
    const GET_DESCRIPTOR = 0x06
    const DT_DEVICE = 0x01
    const wValue = DT_DEVICE << 8
    console.log(
      '%c wValue ⏰ ',
      'background:#6e6e6e; color: #cdfdce;, ⚛︎ fn ⚛︎ wValue',
      wValue
    )

    return this.device_
      .controlTransferIn(
        {
          requestType: 'standard',
          recipient: 'device',
          request: GET_DESCRIPTOR,
          value: wValue,
          index: 0
        },
        18
      )
      .then(result => {
        if (result.status == 'ok') {
          return Promise.resolve(result.data)
        } else {
          return Promise.reject(result.status)
        }
      })
  }

  dfu.Device.prototype.detach = async function () {
    const result = await this.requestOut(dfu.DETACH, undefined, 1000)
    console.log(
      '%c detach result ⏰ ',
      'background:#6e6e6e; color: #cdfdce;, ⚛︎ result',
      result
    )

    return result
  }

  dfu.Device.prototype.readStringDescriptor = async function (index, langID) {
    if (typeof langID === 'undefined') {
      langID = 0
    }

    const GET_DESCRIPTOR = 0x06
    const DT_STRING = 0x03
    const wValue = (DT_STRING << 8) | index

    const request_setup = {
      requestType: 'standard',
      recipient: 'device',
      request: GET_DESCRIPTOR,
      value: wValue,
      index: langID
    }

    // Read enough for bLength
    var result = await this.device_.controlTransferIn(request_setup, 1)

    if (result.status == 'ok') {
      // Retrieve the full descriptor
      const bLength = result.data.getUint8(0)
      result = await this.device_.controlTransferIn(request_setup, bLength)
      if (result.status == 'ok') {
        const len = (bLength - 2) / 2
        let u16_words = []
        for (let i = 0; i < len; i++) {
          u16_words.push(result.data.getUint16(2 + i * 2, true))
        }
        if (langID == 0) {
          // Return the langID array
          return u16_words
        } else {
          // Decode from UCS-2 into a string
          return String.fromCharCode.apply(String, u16_words)
        }
      }
    }

    throw `Failed to read string descriptor ${index}: ${result.status}`
  }

  dfu.Device.prototype.readInterfaceNames = async function () {
    const DT_INTERFACE = 4

    let configs = {}
    let allStringIndices = new Set()
    for (
      let configIndex = 0;
      configIndex < this.device_.configurations.length;
      configIndex++
    ) {
      const rawConfig = await this.readConfigurationDescriptor(configIndex)
      let configDesc = dfu.parseConfigurationDescriptor(rawConfig)
      let configValue = configDesc.bConfigurationValue
      configs[configValue] = {}

      // Retrieve string indices for interface names
      for (let desc of configDesc.descriptors) {
        if (desc.bDescriptorType == DT_INTERFACE) {
          if (!(desc.bInterfaceNumber in configs[configValue])) {
            configs[configValue][desc.bInterfaceNumber] = {}
          }
          configs[configValue][desc.bInterfaceNumber][desc.bAlternateSetting] =
            desc.iInterface
          if (desc.iInterface > 0) {
            allStringIndices.add(desc.iInterface)
          }
        }
      }
    }

    let strings = {}
    // Retrieve interface name strings
    for (let index of allStringIndices) {
      try {
        strings[index] = await this.readStringDescriptor(index, 0x0409)
      } catch (error) {
        console.log(error)
        strings[index] = null
      }
    }

    for (let configValue in configs) {
      for (let intfNumber in configs[configValue]) {
        for (let alt in configs[configValue][intfNumber]) {
          const iIndex = configs[configValue][intfNumber][alt]
          configs[configValue][intfNumber][alt] = strings[iIndex]
        }
      }
    }

    return configs
  }

  dfu.parseDeviceDescriptor = function (data) {
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      bcdUSB: data.getUint16(2, true),
      bDeviceClass: data.getUint8(4),
      bDeviceSubClass: data.getUint8(5),
      bDeviceProtocol: data.getUint8(6),
      bMaxPacketSize: data.getUint8(7),
      idVendor: data.getUint16(8, true),
      idProduct: data.getUint16(10, true),
      bcdDevice: data.getUint16(12, true),
      iManufacturer: data.getUint8(14),
      iProduct: data.getUint8(15),
      iSerialNumber: data.getUint8(16),
      bNumConfigurations: data.getUint8(17)
    }
  }

  dfu.parseConfigurationDescriptor = function (data) {
    let descriptorData = new DataView(data.buffer.slice(9))
    let descriptors = dfu.parseSubDescriptors(descriptorData)
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      wTotalLength: data.getUint16(2, true),
      bNumInterfaces: data.getUint8(4),
      bConfigurationValue: data.getUint8(5),
      iConfiguration: data.getUint8(6),
      bmAttributes: data.getUint8(7),
      bMaxPower: data.getUint8(8),
      descriptors: descriptors
    }
  }

  dfu.parseInterfaceDescriptor = function (data) {
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      bInterfaceNumber: data.getUint8(2),
      bAlternateSetting: data.getUint8(3),
      bNumEndpoints: data.getUint8(4),
      bInterfaceClass: data.getUint8(5),
      bInterfaceSubClass: data.getUint8(6),
      bInterfaceProtocol: data.getUint8(7),
      iInterface: data.getUint8(8),
      descriptors: []
    }
  }

  dfu.parseFunctionalDescriptor = function (data) {
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      bmAttributes: data.getUint8(2),
      wDetachTimeOut: data.getUint16(3, true),
      wTransferSize: data.getUint16(5, true),
      bcdDFUVersion: data.getUint16(7, true)
    }
  }

  dfu.parseSubDescriptors = function (descriptorData) {
    const DT_INTERFACE = 4
    const DT_ENDPOINT = 5
    const DT_DFU_FUNCTIONAL = 0x21
    const USB_CLASS_APP_SPECIFIC = 0xfe
    const USB_SUBCLASS_DFU = 0x01
    let remainingData = descriptorData
    let descriptors = []
    let currIntf
    let inDfuIntf = false
    while (remainingData.byteLength > 2) {
      let bLength = remainingData.getUint8(0)
      let bDescriptorType = remainingData.getUint8(1)
      let descData = new DataView(remainingData.buffer.slice(0, bLength))
      if (bDescriptorType == DT_INTERFACE) {
        currIntf = dfu.parseInterfaceDescriptor(descData)
        if (
          currIntf.bInterfaceClass == USB_CLASS_APP_SPECIFIC &&
          currIntf.bInterfaceSubClass == USB_SUBCLASS_DFU
        ) {
          inDfuIntf = true
        } else {
          inDfuIntf = false
        }
        descriptors.push(currIntf)
      } else if (inDfuIntf && bDescriptorType == DT_DFU_FUNCTIONAL) {
        let funcDesc = dfu.parseFunctionalDescriptor(descData)
        descriptors.push(funcDesc)
        currIntf.descriptors.push(funcDesc)
      } else {
        let desc = {
          bLength: bLength,
          bDescriptorType: bDescriptorType,
          data: descData
        }
        descriptors.push(desc)
        if (currIntf) {
          currIntf.descriptors.push(desc)
        }
      }
      remainingData = new DataView(remainingData.buffer.slice(bLength))
    }

    return descriptors
  }

  dfu.Device.prototype.readConfigurationDescriptor = function (index) {
    const GET_DESCRIPTOR = 0x06
    const DT_CONFIGURATION = 0x02
    const wValue = (DT_CONFIGURATION << 8) | index

    return this.device_
      .controlTransferIn(
        {
          requestType: 'standard',
          recipient: 'device',
          request: GET_DESCRIPTOR,
          value: wValue,
          index: 0
        },
        4
      )
      .then(result => {
        if (result.status == 'ok') {
          // Read out length of the configuration descriptor
          let wLength = result.data.getUint16(2, true)
          return this.device_.controlTransferIn(
            {
              requestType: 'standard',
              recipient: 'device',
              request: GET_DESCRIPTOR,
              value: wValue,
              index: 0
            },
            wLength
          )
        } else {
          return Promise.reject(result.status)
        }
      })
      .then(result => {
        if (result.status == 'ok') {
          return Promise.resolve(result.data)
        } else {
          return Promise.reject(result.status)
        }
      })
  }

  dfu.Device.prototype.waitDisconnected = async function (timeout) {
    const device = this
    const usbDevice = this.device

    return new Promise((resolve, reject) => {
      let timeoutID

      function onDisconnect (event) {
        if (event.device === usbDevice) {
          if (timeout > 0) {
            clearTimeout(timeoutID)
          }
          device.connected = false
          navigator.usb.removeEventListener('disconnect', onDisconnect)
          event.stopPropagation()
          resolve(device)
        }
      }

      if (timeout > 0) {
        timeoutID = window.setTimeout(() => {
          navigator.usb.removeEventListener('disconnect', onDisconnect)

          if (device.connected) {
            reject('Disconnect timeout expired')
          }
        }, timeout)
      } else {
        navigator.usb.addEventListener('disconnect', onDisconnect)
      }
    })
  }

  dfu.Device.prototype.requestOut = async function (
    bRequest,
    data,
    wValue = 0
  ) {
    console.log(
      '%c requestOut  ⏰ ',
      'background:#6e6e6e; color: #cdfdce;, ⚛︎ fn ⚛︎ this.device_',
      this.device_,
      wValue,
      this.intfNumber
    )
    const result = await this.device_.controlTransferOut(
      {
        requestType: 'class',
        recipient: 'interface',
        request: bRequest,
        value: wValue,
        index: this.intfNumber
      },
      data
    )

    console.log('result', result)
    if (result.status == 'ok') {
      return Promise.resolve(this.device_)
    } else {
      return Promise.reject(result.status)
    }

    // error => {
    //   return Promise.reject('ControlTransferOut failed: ' + error)
    // }
  }
}
const dd = fn()
