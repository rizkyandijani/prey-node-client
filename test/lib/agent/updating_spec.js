var join          = require('path').join,
    sinon         = require('sinon'),
    should        = require('should'),
    child_process = require('child_process'),
    needle        = require('needle'),
    tmpdir        = require('os').tmpdir,
    helpers       = require(join('..', '..', 'helpers')),
    common        = require(helpers.lib_path('common')),
    system        = require(helpers.lib_path('system')),
    package       = require(helpers.lib_path('package')),
    geo           = require(helpers.lib_path('agent', 'providers', 'geo')),
    storage       = require(helpers.lib_path('agent', 'utils', 'storage')),
    updater       = require(helpers.lib_path('agent', 'updater'));

var versions_path = system.paths.versions;

describe('updating', function() {

  var branch_stub;

  before(function() {
    common.logger.pause();

    // ensure the config.get('download_edge') call returns false
    branch_stub = sinon.stub(common.config, 'get').callsFake(key => {
      return false;
    })
  })

  after(function() {
    common.logger.resume();
    branch_stub.restore();
  });

  describe('when there is NO versions support', function() {

    before(function(){
      system.paths.versions = undefined;
    });

    after(function() {
      system.paths.versions = versions_path;
    })

    it('callbacks with error', function(done) {
      updater.check(function(err) {
        should.exist(err);
        err.message.should.equal("No versions support.");
        done();
      });
    });

  });

  describe('when there is versions support', function() {

    before(function() {
      system.paths.versions = '/somewhere/over/the/rainbow';
    });

    after(function() {
      system.paths.versions = versions_path;
    })

    describe('and no new versions are found', function() {

      var stub,
          real_version,
          upstream_version;

      before(function(done) {
        real_version = common.version;
        common.version = '1.2.3';
        upstream_version = '1.2.1'; // should not happen, but anyway

        stub = stub_get_stable_version(upstream_version);
        storage.init('versions', tmpdir() + '/version', done);
      });

      after(function(done) {
        common.version = real_version;
        stub.restore();
        storage.close('versions', function() {
          storage.erase(tmpdir() + '/version', done);
        });
      });

      it('callsback with no errors', function(done) {

        updater.check(function(err, ver) {
          should.exist(err);
          err.message.should.containEql('Theres no new version available');
          done();
        });

      })

    })

    describe('when a new version is available', function(){

      var stub,
          real_version,
          upstream_version;

      before(function() {
        real_version = common.version;
        common.version = '1.2.3';
        upstream_version = '1.2.5';

        stub = stub_get_stable_version(upstream_version);
      });

      after(function() {
        common.version = real_version;
        stub.restore();
      });

      // for this test, we fake the 'spawn' call and return a fake child,
      // for whom we will trigger a fake 'exit' event, as if the child process
      // had exited, so updater.check's callback gets triggered
      describe('when upgrading fails', function() {

        var fake_spawn;
        describe('by emits an exit', () => {

          before(function() {
            fake_spawn = sinon.stub(child_process, 'spawn').callsFake((cmd, args, opts) => {
              var child = helpers.fake_spawn_child();

              setTimeout(function(){
                child.stdout.emit('data', new Buffer('Downloading file...'));
                child.stdout.emit('data', new Buffer('Launching rockets'));
                child.stdout.emit('data', new Buffer('SHOOT!!'));
                child.emit('exit');
              }, 10);

              return child;
            });
          })

          after(function() {
            fake_spawn.restore();
          });

          it('callbacks an error', function (done){

            updater.check(function(err) {
              should.exist(err);
              err.message.should.equal('Upgrade to 1.2.5 failed. Exit code: undefined');
              err.stack.should.containEql('Launching rockets\nSHOOT!!');
              done();
            });

          });
        });

        describe('data contains error', () => {
          before(function() {
            updater.check_enabled = true;
            updater.upgrading = false;
            fake_spawn = sinon.stub(child_process, 'spawn').callsFake((cmd, args, opts) => {
              var child = helpers.fake_spawn_child();

              setTimeout(function(){
                child.stdout.emit('data', new Buffer('Downloading file...'));
                child.stdout.emit('data', new Buffer('Launching rockets'));
                child.stdout.emit('data', new Buffer('Error! No, cant do'));
              }, 10);

              post_event_stub = sinon.spy(package, 'post_event');
              geo_loc_stub = sinon.stub(geo, 'fetch_location').callsFake((cb) => {
                return cb(null, {location: {lat: null, lng: null}})
              });
              post_spy = sinon.stub(needle, 'post').callsFake((url, data, opts, cb) => {
                return cb();
              });

              return child;
            });
          })

          after(function(done) {
            fake_spawn.restore();
            post_event_stub.restore();
            post_spy.restore();
            geo_loc_stub.restore();
            storage.close('versions', function() {
              storage.erase(tmpdir() + '/versions', done);
            });
          });

          it('callbacks an error and notifies it', function (done){

            storage.init('versions', tmpdir() + '/versions', (err) => {

              storage.set('version-1.2.5', {from: '1.2.3', to: '1.2.5', attempts: 3, notified: false}, (err) => {

                updater.check_for_update();
                setTimeout(() => {
                  post_spy.calledOnce.should.equal(true);
                  done();
                }, 2500)

              });
            });

          });
        });

      });

      // for this test, we fake the 'spawn' call and return a fake child,
      // for whom we will emit the 'YOUARENOTMYFATHER' string in its stdout
      // as if the updater is succesfully going through.
      describe('when upgrading succeeds', function() {

        var fake_spawn,
            fake_exit,
            exit_code,
            post_event_stub,
            post_spy,
            unreffed = false;

        before(function(done) {
          updater.check_enabled = true;
          updater.upgrading = false;
          fake_spawn = sinon.stub(child_process, 'spawn').callsFake((cmd, args, opts) => {
            var child = helpers.fake_spawn_child();

            child.unref = function() {
              unreffed = true;
              child.emit('exit');
            }

            setTimeout(function() {
              child.stdout.emit('data', new Buffer('YOUARENOTMYFATHER'));
            }, 100);

            return child;
          });

          fake_exit = sinon.stub(process, 'exit').callsFake(code => {
            exit_code = code;
          });

          post_event_stub = sinon.spy(package, 'post_event');
          geo_loc_stub = sinon.stub(geo, 'fetch_location').callsFake((cb) => {
            return cb(null, {location: {lat: null, lng: null}})
          });
          post_spy = sinon.stub(needle, 'post').callsFake((url, data, opts, cb) => {
            return cb();
          });

          storage.init('versions', tmpdir() + '/versions', done);
        });

        after(function(done) {
          fake_spawn.restore();
          fake_exit.restore();
          post_event_stub.restore();
          geo_loc_stub.restore();
          post_spy.restore();
          storage.close('versions', function() {
            storage.erase(tmpdir() + '/versions', done);
          });
        });

        it('process exits with status code(0)', function (done){
          this.timeout(16000);
          updater.check(function(err) {
            exit_code.should.equal(0);
            unreffed.should.be.true;
            done();
          });

        });

        it('notifies update success when the client restarts after upgrade', (done) => {
          updater.check_enabled = true;
          updater.upgrading = false;
          common.version = '1.2.5';
          storage.set('version-1.2.5', {from: '1.2.3', to: '1.2.5', attempts: 5, notified: false}, () => {
            updater.check_for_update(function(err) {
              should.exist(err);
              err.message.should.containEql('Theres no new version available');
              post_spy.calledOnce.should.equal(true);
              storage.all('versions', (err, out) => {
                Object.keys(out).length.should.be.equal(0)
                done();
              })
            });
          });
        })

      });

    });

  });

  function stub_get_stable_version(ver) {
    var fn = function(url, opts, cb) {
      if (typeof opts == 'function') {
        cb = opts;
        opts = {};
      }

      function resp(err, body, code) {
        cb(null, { statusCode: code || 200, body: body }, body);
      }

      if (url.match('latest.txt')) {
        resp(null, ver);
      } else {
        resp(new Error('GET ' + url));
      }
    };

    return sinon.stub(needle, 'get').callsFake(fn);
  }

});
